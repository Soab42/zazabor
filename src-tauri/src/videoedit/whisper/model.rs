//! Whisper's network on candle (CPU), with OpenAI's tensor names as whisper.cpp keeps them: the
//! audio encoder (two convolutions and transformer blocks) and the text decoder (self- and
//! cross-attention with a key/value cache, so each new token costs one step). Adapted from the
//! architecture in openai/whisper (MIT).

use super::ggml::{GgmlModel, Hparams};
use candle_core::{DType, Device, Module, Tensor};
use candle_nn::{ops::softmax_last_dim, Conv1d, Conv1dConfig, LayerNorm, Linear};
use std::collections::HashMap;

type R<T> = candle_core::Result<T>;

fn take(t: &mut HashMap<String, Tensor>, name: &str) -> Result<Tensor, String> {
    t.remove(name).ok_or_else(|| format!("The captions model has no {name}."))
}

fn linear(t: &mut HashMap<String, Tensor>, name: &str, bias: bool) -> Result<Linear, String> {
    let w = take(t, &format!("{name}.weight"))?;
    let b = if bias { Some(take(t, &format!("{name}.bias"))?) } else { None };
    Ok(Linear::new(w, b))
}

fn norm(t: &mut HashMap<String, Tensor>, name: &str) -> Result<LayerNorm, String> {
    Ok(LayerNorm::new(take(t, &format!("{name}.weight"))?, take(t, &format!("{name}.bias"))?, 1e-5))
}

struct Attention {
    query: Linear,
    key: Linear,
    value: Linear,
    out: Linear,
    heads: usize,
    /// Self-attention: the keys and values so far. Cross-attention: those of the audio.
    kv: Option<(Tensor, Tensor)>,
}

impl Attention {
    fn load(t: &mut HashMap<String, Tensor>, name: &str, heads: usize) -> Result<Self, String> {
        Ok(Attention {
            query: linear(t, &format!("{name}.query"), true)?,
            key: linear(t, &format!("{name}.key"), false)?,
            value: linear(t, &format!("{name}.value"), true)?,
            out: linear(t, &format!("{name}.out"), true)?,
            heads,
            kv: None,
        })
    }

    /// Self-attention over `x` (appended to the cache) or cross-attention over `xa`.
    fn forward(&mut self, x: &Tensor, xa: Option<&Tensor>, mask: Option<&Tensor>) -> R<Tensor> {
        let q = self.query.forward(x)?;
        let (k, v) = match xa {
            Some(xa) => {
                if self.kv.is_none() {
                    self.kv = Some((self.key.forward(xa)?, self.value.forward(xa)?));
                }
                self.kv.clone().expect("just set")
            }
            None => {
                let (k, v) = (self.key.forward(x)?, self.value.forward(x)?);
                let (k, v) = match &self.kv {
                    Some((pk, pv)) => (Tensor::cat(&[pk, &k], 1)?, Tensor::cat(&[pv, &v], 1)?),
                    None => (k, v),
                };
                self.kv = Some((k.clone(), v.clone()));
                (k, v)
            }
        };
        let wv = self.attend(&q, &k, &v, mask)?;
        self.out.forward(&wv)
    }

    fn attend(&self, q: &Tensor, k: &Tensor, v: &Tensor, mask: Option<&Tensor>) -> R<Tensor> {
        let (b, n_q, state) = q.dims3()?;
        let n_k = k.dim(1)?;
        let d = state / self.heads;
        let scale = (d as f64).powf(-0.25);
        let q = q.reshape((b, n_q, self.heads, d))?.transpose(1, 2)?.contiguous()?.affine(scale, 0.0)?;
        let k = k.reshape((b, n_k, self.heads, d))?.permute((0, 2, 3, 1))?.contiguous()?.affine(scale, 0.0)?;
        let v = v.reshape((b, n_k, self.heads, d))?.transpose(1, 2)?.contiguous()?;
        let mut qk = q.matmul(&k)?;
        if let Some(mask) = mask {
            qk = qk.broadcast_add(mask)?;
        }
        let w = softmax_last_dim(&qk)?;
        w.matmul(&v)?.transpose(1, 2)?.flatten_from(2)
    }
}

struct Block {
    attn: Attention,
    attn_ln: LayerNorm,
    cross: Option<(Attention, LayerNorm)>,
    mlp_ln: LayerNorm,
    mlp_up: Linear,
    mlp_down: Linear,
}

impl Block {
    fn load(t: &mut HashMap<String, Tensor>, name: &str, heads: usize, cross: bool) -> Result<Self, String> {
        Ok(Block {
            attn: Attention::load(t, &format!("{name}.attn"), heads)?,
            attn_ln: norm(t, &format!("{name}.attn_ln"))?,
            cross: if cross { Some((Attention::load(t, &format!("{name}.cross_attn"), heads)?, norm(t, &format!("{name}.cross_attn_ln"))?)) } else { None },
            mlp_ln: norm(t, &format!("{name}.mlp_ln"))?,
            mlp_up: linear(t, &format!("{name}.mlp.0"), true)?,
            mlp_down: linear(t, &format!("{name}.mlp.2"), true)?,
        })
    }

    fn forward(&mut self, x: &Tensor, xa: Option<&Tensor>, mask: Option<&Tensor>) -> R<Tensor> {
        let mut x = (x + self.attn.forward(&self.attn_ln.forward(x)?, None, mask)?)?;
        if let Some((cross, ln)) = self.cross.as_mut() {
            x = (&x + cross.forward(&ln.forward(&x)?, xa, None)?)?;
        }
        let h = self.mlp_down.forward(&self.mlp_up.forward(&self.mlp_ln.forward(&x)?)?.gelu_erf()?)?;
        x + h
    }
}

pub struct Whisper {
    pub hp: Hparams,
    conv1: Conv1d,
    conv2: Conv1d,
    audio_pos: Tensor,
    audio_blocks: Vec<Block>,
    audio_ln: LayerNorm,
    token_embedding: Tensor,
    /// The embedding transposed (state × vocab), for the logits.
    token_out: Tensor,
    text_pos: Tensor,
    text_blocks: Vec<Block>,
    text_ln: LayerNorm,
    /// Tokens already in the decoder's cache.
    cached: usize,
}

impl Whisper {
    pub fn load(m: &mut GgmlModel) -> Result<Whisper, String> {
        let hp = m.hp;
        let t = &mut m.tensors;
        let conv = |t: &mut HashMap<String, Tensor>, name: &str, stride: usize| -> Result<Conv1d, String> {
            let cfg = Conv1dConfig { padding: 1, stride, dilation: 1, groups: 1, cudnn_fwd_algo: None };
            Ok(Conv1d::new(take(t, &format!("{name}.weight"))?, Some(take(t, &format!("{name}.bias"))?.flatten_all().map_err(|e| e.to_string())?), cfg))
        };
        let conv1 = conv(t, "encoder.conv1", 1)?;
        let conv2 = conv(t, "encoder.conv2", 2)?;
        let audio_pos = take(t, "encoder.positional_embedding")?;
        let audio_blocks = (0..hp.n_audio_layer).map(|i| Block::load(t, &format!("encoder.blocks.{i}"), hp.n_audio_head, false)).collect::<Result<_, _>>()?;
        let audio_ln = norm(t, "encoder.ln_post")?;
        let token_embedding = take(t, "decoder.token_embedding.weight")?;
        let token_out = token_embedding.t().and_then(|x| x.contiguous()).map_err(|e| e.to_string())?;
        let text_pos = take(t, "decoder.positional_embedding")?;
        let text_blocks = (0..hp.n_text_layer).map(|i| Block::load(t, &format!("decoder.blocks.{i}"), hp.n_text_head, true)).collect::<Result<_, _>>()?;
        let text_ln = norm(t, "decoder.ln")?;
        Ok(Whisper { hp, conv1, conv2, audio_pos, audio_blocks, audio_ln, token_embedding, token_out, text_pos, text_blocks, text_ln, cached: 0 })
    }

    /// The audio features of a 30-second mel window (`n_mels` × 3000, row-major).
    pub fn encode(&mut self, mel: &[f32], frames: usize) -> R<Tensor> {
        let x = Tensor::from_slice(mel, (1, self.hp.n_mels, frames), &Device::Cpu)?;
        let x = self.conv1.forward(&x)?.gelu_erf()?;
        let x = self.conv2.forward(&x)?.gelu_erf()?;
        let x = x.transpose(1, 2)?;
        let n = x.dim(1)?;
        let mut x = x.broadcast_add(&self.audio_pos.narrow(0, 0, n)?)?;
        for block in self.audio_blocks.iter_mut() {
            x = block.forward(&x, None, None)?;
        }
        self.audio_ln.forward(&x)
    }

    /// Starts decoding a new window: forgets the cached tokens and the previous audio.
    pub fn reset(&mut self) {
        self.cached = 0;
        for block in self.text_blocks.iter_mut() {
            block.attn.kv = None;
            if let Some((cross, _)) = block.cross.as_mut() {
                cross.kv = None;
            }
        }
    }

    /// Feeds `tokens` after those already decoded; returns the logits at each of `at`
    /// (positions within `tokens`), each a vocabulary-long row.
    pub fn decode(&mut self, tokens: &[u32], audio: &Tensor, at: &[usize]) -> R<Vec<Vec<f32>>> {
        let n = tokens.len();
        let ids = Tensor::new(tokens, &Device::Cpu)?;
        let x = self.token_embedding.index_select(&ids, 0)?.unsqueeze(0)?;
        let pos = self.text_pos.narrow(0, self.cached, n)?;
        let mut x = x.broadcast_add(&pos)?;
        // Causal mask for several new tokens (one token sees everything cached).
        let mask = if n > 1 {
            let past = self.cached;
            let m: Vec<f32> = (0..n).flat_map(|i| (0..past + n).map(move |j| if j > past + i { f32::NEG_INFINITY } else { 0.0 })).collect();
            Some(Tensor::from_vec(m, (n, past + n), &Device::Cpu)?)
        } else {
            None
        };
        for block in self.text_blocks.iter_mut() {
            x = block.forward(&x, Some(audio), mask.as_ref())?;
        }
        self.cached += n;
        let x = self.text_ln.forward(&x)?;
        let mut out = Vec::with_capacity(at.len());
        for &p in at {
            let row = x.narrow(1, p, 1)?.squeeze(1)?;
            let logits = row.matmul(&self.token_out)?.squeeze(0)?.to_dtype(DType::F32)?;
            out.push(logits.to_vec1::<f32>()?);
        }
        Ok(out)
    }

    pub fn text_ctx(&self) -> usize {
        self.hp.n_text_ctx
    }

    /// Positions the decoder can still take before its context is full.
    pub fn room(&self) -> usize {
        self.hp.n_text_ctx.saturating_sub(self.cached)
    }
}

/// The largest value's index.
pub fn argmax(v: &[f32]) -> usize {
    let mut best = 0;
    for (i, x) in v.iter().enumerate() {
        if *x > v[best] {
            best = i;
        }
    }
    best
}
