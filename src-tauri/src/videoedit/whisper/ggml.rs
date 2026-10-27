//! whisper.cpp's model files (`ggml-base.bin`, `ggml-small.bin`): the hyperparameters, the mel
//! filter bank, the vocabulary (as raw bytes) and the weights, named as in OpenAI's checkpoints.
//! Only f32 and f16 tensors are read (the quantized files aren't offered).

use candle_core::{DType, Device, Tensor};
use std::collections::HashMap;
use std::io::{BufReader, Read};
use std::path::Path;

const MAGIC: u32 = 0x6767_6d6c;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Hparams {
    pub n_vocab: usize,
    pub n_audio_ctx: usize,
    pub n_audio_state: usize,
    pub n_audio_head: usize,
    pub n_audio_layer: usize,
    pub n_text_ctx: usize,
    pub n_text_state: usize,
    pub n_text_head: usize,
    pub n_text_layer: usize,
    pub n_mels: usize,
}

pub struct GgmlModel {
    pub hp: Hparams,
    /// `n_mels` rows of `n_fft` (= 201) weights.
    pub mel_filters: Vec<f32>,
    pub n_fft: usize,
    /// Each token's text as bytes (UTF-8 may split across tokens).
    pub vocab: Vec<Vec<u8>>,
    pub tensors: HashMap<String, Tensor>,
}

fn i32_of(r: &mut impl Read) -> Result<i32, String> {
    let mut b = [0u8; 4];
    r.read_exact(&mut b).map_err(|e| format!("The model file is cut short ({e})."))?;
    Ok(i32::from_le_bytes(b))
}

fn usize_of(r: &mut impl Read, what: &str) -> Result<usize, String> {
    let v = i32_of(r)?;
    usize::try_from(v).map_err(|_| format!("The model file has a bad {what} ({v})."))
}

/// Reads a whole model file onto the CPU, widening f16 weights to f32.
pub fn read(path: &Path) -> Result<GgmlModel, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("Couldn't open the captions model: {e}"))?;
    read_from(&mut BufReader::with_capacity(1 << 20, file))
}

pub fn read_from(r: &mut impl Read) -> Result<GgmlModel, String> {
    if i32_of(r)? as u32 != MAGIC {
        return Err("This isn't a whisper.cpp model file.".into());
    }
    let mut next = |what: &str| usize_of(r, what);
    let hp = Hparams {
        n_vocab: next("vocabulary size")?,
        n_audio_ctx: next("audio context")?,
        n_audio_state: next("audio width")?,
        n_audio_head: next("audio heads")?,
        n_audio_layer: next("audio layers")?,
        n_text_ctx: next("text context")?,
        n_text_state: next("text width")?,
        n_text_head: next("text heads")?,
        n_text_layer: next("text layers")?,
        n_mels: next("mel bands")?,
    };
    let _ftype = i32_of(r)?;
    if hp.n_audio_state == 0 || hp.n_audio_head == 0 || hp.n_audio_state % hp.n_audio_head != 0 || hp.n_text_state % hp.n_text_head.max(1) != 0 {
        return Err("The model file's sizes don't add up.".into());
    }

    let n_mel = usize_of(r, "filter count")?;
    let n_fft = usize_of(r, "filter width")?;
    if n_mel != hp.n_mels || n_fft == 0 || n_fft > 4096 {
        return Err("The model file's mel filters don't match it.".into());
    }
    let mut raw = vec![0u8; n_mel * n_fft * 4];
    r.read_exact(&mut raw).map_err(|e| format!("The model file is cut short ({e})."))?;
    let mel_filters = raw.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();

    let count = usize_of(r, "vocabulary")?;
    if count > 1_000_000 {
        return Err("The model file's vocabulary is too big.".into());
    }
    let mut vocab = Vec::with_capacity(count);
    for _ in 0..count {
        let len = usize_of(r, "token")?;
        if len > 1024 {
            return Err("The model file has a bad token.".into());
        }
        let mut word = vec![0u8; len];
        r.read_exact(&mut word).map_err(|e| format!("The model file is cut short ({e})."))?;
        vocab.push(word);
    }

    let mut tensors = HashMap::new();
    loop {
        // End of file: the first read of a tensor header fails cleanly.
        let mut b = [0u8; 4];
        match r.read(&mut b[..1]) {
            Ok(0) => break,
            Ok(_) => r.read_exact(&mut b[1..]).map_err(|e| format!("The model file is cut short ({e})."))?,
            Err(e) => return Err(format!("Couldn't read the captions model: {e}")),
        }
        let n_dims = i32::from_le_bytes(b);
        let name_len = usize_of(r, "tensor name")?;
        let ttype = i32_of(r)?;
        if !(1..=4).contains(&n_dims) || name_len > 256 {
            return Err("The model file has a bad tensor.".into());
        }
        let mut ne = Vec::with_capacity(n_dims as usize);
        for _ in 0..n_dims {
            ne.push(usize_of(r, "tensor size")?);
        }
        let mut name = vec![0u8; name_len];
        r.read_exact(&mut name).map_err(|e| format!("The model file is cut short ({e})."))?;
        let name = String::from_utf8(name).map_err(|_| "The model file has a bad tensor name.".to_string())?;
        let (dtype, size) = match ttype {
            0 => (DType::F32, 4),
            1 => (DType::F16, 2),
            _ => return Err("This captions model is quantized, which Zazabor can't read; use Base or Small.".into()),
        };
        let elements: usize = ne.iter().product();
        if elements == 0 || elements > 1 << 30 {
            return Err("The model file has a bad tensor.".into());
        }
        let mut data = vec![0u8; elements * size];
        r.read_exact(&mut data).map_err(|e| format!("The model file is cut short ({e})."))?;
        // ggml lists the fastest-moving dimension first; PyTorch (and candle) the slowest.
        let shape: Vec<usize> = ne.iter().rev().copied().collect();
        let tensor = Tensor::from_raw_buffer(&data, dtype, &shape, &Device::Cpu)
            .and_then(|t| t.to_dtype(DType::F32))
            .map_err(|e| format!("Couldn't load the captions model: {e}"))?;
        tensors.insert(name, tensor);
    }
    Ok(GgmlModel { hp, mel_filters, n_fft, vocab, tensors })
}

#[cfg(test)]
pub mod tests {
    use super::*;

    /// A tiny model file in whisper.cpp's layout, for tests of the reader.
    pub fn tiny_file(tensors: &[(&str, &[usize], &[f32])]) -> Vec<u8> {
        fn put(v: i32, out: &mut Vec<u8>) {
            out.extend_from_slice(&v.to_le_bytes());
        }
        let mut out = Vec::new();
        put(MAGIC as i32, &mut out);
        for v in [4, 2, 4, 2, 1, 4, 4, 2, 1, 2, 0] {
            put(v, &mut out);
        }
        put(2, &mut out);
        put(3, &mut out);
        for i in 0..6 {
            out.extend_from_slice(&(i as f32).to_le_bytes());
        }
        put(2, &mut out);
        for w in [b"a".as_slice(), b"bc".as_slice()] {
            put(w.len() as i32, &mut out);
            out.extend_from_slice(w);
        }
        for (name, shape, values) in tensors {
            put(shape.len() as i32, &mut out);
            put(name.len() as i32, &mut out);
            put(0, &mut out);
            for d in shape.iter().rev() {
                put(*d as i32, &mut out);
            }
            out.extend_from_slice(name.as_bytes());
            for v in *values {
                out.extend_from_slice(&v.to_le_bytes());
            }
        }
        out
    }

    #[test]
    fn reads_hparams_filters_vocab_and_tensors() {
        let bytes = tiny_file(&[("w", &[2, 3], &[1.0, 2.0, 3.0, 4.0, 5.0, 6.0])]);
        let m = read_from(&mut bytes.as_slice()).unwrap();
        assert_eq!(m.hp.n_vocab, 4);
        assert_eq!(m.hp.n_mels, 2);
        assert_eq!(m.n_fft, 3);
        assert_eq!(m.mel_filters, vec![0.0, 1.0, 2.0, 3.0, 4.0, 5.0]);
        assert_eq!(m.vocab, vec![b"a".to_vec(), b"bc".to_vec()]);
        let w = &m.tensors["w"];
        assert_eq!(w.dims(), &[2, 3]);
        assert_eq!(w.to_vec2::<f32>().unwrap(), vec![vec![1.0, 2.0, 3.0], vec![4.0, 5.0, 6.0]]);
    }

    #[test]
    fn rejects_other_files() {
        assert!(read_from(&mut [1u8, 2, 3, 4].as_slice()).is_err());
        let mut bytes = tiny_file(&[("w", &[2, 3], &[1.0, 2.0, 3.0, 4.0, 5.0, 6.0])]);
        bytes.truncate(bytes.len() - 3);
        assert!(read_from(&mut bytes.as_slice()).is_err());
    }
}
