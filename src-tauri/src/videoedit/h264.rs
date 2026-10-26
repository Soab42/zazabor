//! H.264 from VA-API's encoder into MP4. `vaapih264enc` only writes Annex B byte-stream (start
//! codes), and `mp4mux` only takes length-prefixed access units with an `avcC` record in the caps;
//! the parser that converts between them (`h264parse`, plugins-bad) isn't installed here. So this
//! does the conversion: split at start codes, drop access unit delimiters, keep the first SPS and
//! PPS for `avcC`, and prefix every other NAL unit with its 4-byte length.

/// NAL unit types this cares about.
const NAL_IDR: u8 = 5;
const NAL_SPS: u8 = 7;
const NAL_PPS: u8 = 8;
const NAL_AUD: u8 = 9;

/// The NAL units of an Annex B buffer, without their start codes (3- or 4-byte).
pub fn split_annex_b(data: &[u8]) -> Vec<&[u8]> {
    let mut starts = Vec::new();
    let mut i = 0;
    while i + 3 <= data.len() {
        if data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1 {
            starts.push(i + 3);
            i += 3;
        } else {
            i += 1;
        }
    }
    let mut units = Vec::with_capacity(starts.len());
    for (n, &start) in starts.iter().enumerate() {
        let mut end = if n + 1 < starts.len() { starts[n + 1] - 3 } else { data.len() };
        // A 4-byte start code leaves its leading zero on the previous unit; trailing zeros
        // aren't part of a NAL unit either.
        while end > start && data[end - 1] == 0 {
            end -= 1;
        }
        if end > start {
            units.push(&data[start..end]);
        }
    }
    units
}

fn nal_type(unit: &[u8]) -> u8 {
    unit.first().map_or(0, |b| b & 0x1f)
}

/// The `avcC` decoder configuration record (ISO/IEC 14496-15) for one SPS and one PPS, with
/// 4-byte lengths. High profiles carry the 4:2:0, 8-bit extension that VA-API's output always is.
pub fn avcc(sps: &[u8], pps: &[u8]) -> Vec<u8> {
    let mut out = vec![1, sps.get(1).copied().unwrap_or(66), sps.get(2).copied().unwrap_or(0), sps.get(3).copied().unwrap_or(30), 0xff, 0xe1];
    out.extend_from_slice(&(sps.len() as u16).to_be_bytes());
    out.extend_from_slice(sps);
    out.push(1);
    out.extend_from_slice(&(pps.len() as u16).to_be_bytes());
    out.extend_from_slice(pps);
    if matches!(sps.get(1), Some(100 | 110 | 122 | 144)) {
        out.extend_from_slice(&[0xfd, 0xf8, 0xf8, 0x00]);
    }
    out
}

/// One converted access unit.
pub struct AccessUnit {
    pub data: Vec<u8>,
    pub keyframe: bool,
}

/// Converts a stream's access units; the first SPS and PPS become the `avcC` record.
#[derive(Default)]
pub struct Converter {
    sps: Option<Vec<u8>>,
    pps: Option<Vec<u8>>,
}

impl Converter {
    /// The `avcC` record, once an SPS and a PPS have been seen.
    pub fn codec_data(&self) -> Option<Vec<u8>> {
        Some(avcc(self.sps.as_deref()?, self.pps.as_deref()?))
    }

    /// One Annex B access unit to length-prefixed form. Parameter sets equal to the ones in
    /// `avcC` are dropped from the samples; changed ones stay in-band.
    pub fn convert(&mut self, data: &[u8]) -> AccessUnit {
        let mut out = Vec::with_capacity(data.len() + 16);
        let mut keyframe = false;
        for unit in split_annex_b(data) {
            match nal_type(unit) {
                NAL_AUD => continue,
                NAL_SPS => {
                    if self.sps.is_none() {
                        self.sps = Some(unit.to_vec());
                    }
                    if self.sps.as_deref() == Some(unit) {
                        continue;
                    }
                }
                NAL_PPS => {
                    if self.pps.is_none() {
                        self.pps = Some(unit.to_vec());
                    }
                    if self.pps.as_deref() == Some(unit) {
                        continue;
                    }
                }
                NAL_IDR => keyframe = true,
                _ => {}
            }
            out.extend_from_slice(&(unit.len() as u32).to_be_bytes());
            out.extend_from_slice(unit);
        }
        AccessUnit { data: out, keyframe }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SPS: [u8; 5] = [0x67, 100, 0, 40, 0xac];
    const PPS: [u8; 3] = [0x68, 0xee, 0x3c];

    fn annex_b(units: &[&[u8]], four: bool) -> Vec<u8> {
        let mut out = Vec::new();
        for unit in units {
            out.extend_from_slice(if four { &[0, 0, 0, 1] } else { &[0, 0, 1] });
            out.extend_from_slice(unit);
        }
        out
    }

    #[test]
    fn splits_three_and_four_byte_start_codes() {
        let data = [0, 0, 0, 1, 0x09, 0x10, 0, 0, 1, 0x67, 1, 2, 0, 0, 0, 1, 0x65, 9, 9];
        let units = split_annex_b(&data);
        assert_eq!(units, vec![&[0x09, 0x10][..], &[0x67, 1, 2][..], &[0x65, 9, 9][..]]);
    }

    #[test]
    fn ignores_garbage_before_the_first_start_code() {
        assert_eq!(split_annex_b(&[7, 7, 0, 0, 1, 0x41, 5]), vec![&[0x41, 5][..]]);
        assert!(split_annex_b(&[1, 2, 3]).is_empty());
    }

    #[test]
    fn avcc_has_profile_lengths_and_high_profile_extension() {
        let record = avcc(&SPS, &PPS);
        assert_eq!(&record[..6], &[1, 100, 0, 40, 0xff, 0xe1]);
        assert_eq!(&record[6..8], &[0, 5]);
        assert_eq!(&record[8..13], &SPS);
        assert_eq!(&record[13..16], &[1, 0, 3]);
        assert_eq!(&record[16..19], &PPS);
        assert_eq!(&record[19..], &[0xfd, 0xf8, 0xf8, 0]);
        let baseline = avcc(&[0x67, 66, 0xc0, 30], &PPS);
        assert_eq!(baseline.len(), 6 + 2 + 4 + 3 + 3);
    }

    #[test]
    fn converts_access_units_and_keeps_parameter_sets_out_of_samples() {
        let mut converter = Converter::default();
        assert!(converter.codec_data().is_none());
        let idr: &[u8] = &[0x65, 0x88, 0x80];
        let first = converter.convert(&annex_b(&[&[0x09, 0xf0], &SPS, &PPS, idr], true));
        assert!(first.keyframe);
        assert_eq!(first.data, [&[0, 0, 0, 3][..], idr].concat());
        assert_eq!(converter.codec_data().unwrap(), avcc(&SPS, &PPS));

        let p: &[u8] = &[0x41, 0x9a, 0x00, 0x21];
        let second = converter.convert(&annex_b(&[&[0x09, 0x30], p], false));
        assert!(!second.keyframe);
        assert_eq!(second.data, [&[0, 0, 0, 4][..], p].concat());

        // A changed PPS stays in the sample.
        let pps2: &[u8] = &[0x68, 0xef];
        let third = converter.convert(&annex_b(&[&SPS, pps2, idr], true));
        assert!(third.keyframe);
        assert_eq!(third.data, [&[0, 0, 0, 2][..], pps2, &[0, 0, 0, 3], idr].concat());
    }
}
