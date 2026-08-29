//! Bounded Diagnostics over Internet Protocol (DoIP) codec.
use crate::ParseError;

pub const DOIP_PORT: u16 = 13_400;
pub const HEADER_LEN: usize = 8;
pub const MAX_PAYLOAD_LEN: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DoipHeader {
    pub version: u8,
    pub inverse_version: u8,
    pub payload_type: u16,
    pub payload_length: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DoipPayload<'a> {
    HeaderNack {
        code: u8,
    },
    VehicleIdRequest,
    VehicleIdRequestEid {
        eid: [u8; 6],
    },
    VehicleIdRequestVin {
        vin: [u8; 17],
    },
    VehicleAnnouncement {
        vin: [u8; 17],
        logical_address: u16,
        eid: [u8; 6],
        gid: [u8; 6],
        further_action: u8,
        sync_status: Option<u8>,
    },
    RoutingActivationRequest {
        source_address: u16,
        activation_type: u8,
        oem: Option<u32>,
    },
    RoutingActivationResponse {
        tester_address: u16,
        entity_address: u16,
        response_code: u8,
        oem: Option<u32>,
    },
    AliveCheckRequest,
    AliveCheckResponse {
        source_address: u16,
    },
    EntityStatusRequest,
    EntityStatusResponse {
        node_type: u8,
        max_open_sockets: u8,
        open_sockets: u8,
        max_data_size: Option<u32>,
    },
    PowerModeRequest,
    PowerModeResponse {
        mode: u8,
    },
    Diagnostic {
        source_address: u16,
        target_address: u16,
        uds: &'a [u8],
    },
    DiagnosticAck {
        source_address: u16,
        target_address: u16,
        code: u8,
        previous: &'a [u8],
    },
    DiagnosticNack {
        source_address: u16,
        target_address: u16,
        code: u8,
        previous: &'a [u8],
    },
    Unknown {
        payload_type: u16,
        body: &'a [u8],
    },
}

/// Parses and validates the fixed header without requiring the declared body.
///
/// This is useful for TCP segment dissection, where a message may begin in the
/// current segment and continue in the next one.
pub fn parse_header_prefix(buf: &[u8]) -> Result<DoipHeader, ParseError> {
    let h = buf.get(..HEADER_LEN).ok_or(ParseError::Truncated)?;
    if h[1] != !h[0] {
        return Err(ParseError::Malformed);
    }
    let payload_length = u32::from_be_bytes(h[4..8].try_into().expect("exact"));
    let len = usize::try_from(payload_length).map_err(|_| ParseError::Malformed)?;
    if len > MAX_PAYLOAD_LEN {
        return Err(ParseError::Malformed);
    }
    Ok(DoipHeader {
        version: h[0],
        inverse_version: h[1],
        payload_type: u16::from_be_bytes([h[2], h[3]]),
        payload_length,
    })
}

pub fn parse_header(buf: &[u8]) -> Result<(DoipHeader, &[u8]), ParseError> {
    let header = parse_header_prefix(buf)?;
    let len = header.payload_length as usize;
    let body = buf
        .get(HEADER_LEN..HEADER_LEN + len)
        .ok_or(ParseError::Truncated)?;
    Ok((header, body))
}

pub fn plausible(buf: &[u8]) -> bool {
    parse_header(buf)
        .map(|(h, _)| ty_code(h.payload_type) != 255)
        .unwrap_or(false)
}

fn exact(body: &[u8], len: usize) -> Result<(), ParseError> {
    if body.len() < len {
        Err(ParseError::Truncated)
    } else if body.len() > len {
        Err(ParseError::Malformed)
    } else {
        Ok(())
    }
}

fn optional_u32(body: &[u8], base: usize) -> Result<Option<u32>, ParseError> {
    match body.len() {
        n if n == base => Ok(None),
        n if n == base + 4 => Ok(Some(u32::from_be_bytes(
            body[base..base + 4].try_into().expect("exact"),
        ))),
        n if n < base => Err(ParseError::Truncated),
        _ => Err(ParseError::Malformed),
    }
}

pub fn parse_payload<'a>(
    header: DoipHeader,
    body: &'a [u8],
) -> Result<DoipPayload<'a>, ParseError> {
    if body.len() != header.payload_length as usize {
        return Err(if body.len() < header.payload_length as usize {
            ParseError::Truncated
        } else {
            ParseError::Malformed
        });
    }
    Ok(match header.payload_type {
        0x0000 => {
            exact(body, 1)?;
            DoipPayload::HeaderNack { code: body[0] }
        }
        0x0001 => {
            exact(body, 0)?;
            DoipPayload::VehicleIdRequest
        }
        0x0002 => {
            exact(body, 6)?;
            DoipPayload::VehicleIdRequestEid {
                eid: body.try_into().expect("exact"),
            }
        }
        0x0003 => {
            exact(body, 17)?;
            DoipPayload::VehicleIdRequestVin {
                vin: body.try_into().expect("exact"),
            }
        }
        0x0004 => {
            if !matches!(body.len(), 32 | 33) {
                return Err(if body.len() < 32 {
                    ParseError::Truncated
                } else {
                    ParseError::Malformed
                });
            }
            DoipPayload::VehicleAnnouncement {
                vin: body[0..17].try_into().expect("exact"),
                logical_address: u16::from_be_bytes([body[17], body[18]]),
                eid: body[19..25].try_into().expect("exact"),
                gid: body[25..31].try_into().expect("exact"),
                further_action: body[31],
                sync_status: body.get(32).copied(),
            }
        }
        0x0005 => DoipPayload::RoutingActivationRequest {
            source_address: {
                if body.len() < 7 {
                    return Err(ParseError::Truncated);
                }
                u16::from_be_bytes([body[0], body[1]])
            },
            activation_type: body[2],
            oem: optional_u32(body, 7)?,
        },
        0x0006 => DoipPayload::RoutingActivationResponse {
            tester_address: {
                if body.len() < 9 {
                    return Err(ParseError::Truncated);
                }
                u16::from_be_bytes([body[0], body[1]])
            },
            entity_address: u16::from_be_bytes([body[2], body[3]]),
            response_code: body[4],
            oem: optional_u32(body, 9)?,
        },
        0x0007 => {
            exact(body, 0)?;
            DoipPayload::AliveCheckRequest
        }
        0x0008 => {
            exact(body, 2)?;
            DoipPayload::AliveCheckResponse {
                source_address: u16::from_be_bytes([body[0], body[1]]),
            }
        }
        0x4001 => {
            exact(body, 0)?;
            DoipPayload::EntityStatusRequest
        }
        0x4002 => {
            if body.len() < 3 {
                return Err(ParseError::Truncated);
            }
            DoipPayload::EntityStatusResponse {
                node_type: body[0],
                max_open_sockets: body[1],
                open_sockets: body[2],
                max_data_size: optional_u32(body, 3)?,
            }
        }
        0x4003 => {
            exact(body, 0)?;
            DoipPayload::PowerModeRequest
        }
        0x4004 => {
            exact(body, 1)?;
            DoipPayload::PowerModeResponse { mode: body[0] }
        }
        0x8001 => {
            if body.len() < 4 {
                return Err(ParseError::Truncated);
            }
            DoipPayload::Diagnostic {
                source_address: u16::from_be_bytes([body[0], body[1]]),
                target_address: u16::from_be_bytes([body[2], body[3]]),
                uds: &body[4..],
            }
        }
        0x8002 | 0x8003 => {
            if body.len() < 5 {
                return Err(ParseError::Truncated);
            }
            let source_address = u16::from_be_bytes([body[0], body[1]]);
            let target_address = u16::from_be_bytes([body[2], body[3]]);
            let code = body[4];
            let previous = &body[5..];
            if header.payload_type == 0x8002 {
                DoipPayload::DiagnosticAck {
                    source_address,
                    target_address,
                    code,
                    previous,
                }
            } else {
                DoipPayload::DiagnosticNack {
                    source_address,
                    target_address,
                    code,
                    previous,
                }
            }
        }
        payload_type => DoipPayload::Unknown { payload_type, body },
    })
}

pub fn ty_code(payload_type: u16) -> u8 {
    match payload_type {
        0x0000..=0x0008 => payload_type as u8,
        0x4001..=0x4004 => (payload_type - 0x4001 + 9) as u8,
        0x8001..=0x8003 => (payload_type - 0x8001 + 13) as u8,
        _ => 255,
    }
}

pub fn type_name(payload_type: u16) -> &'static str {
    match payload_type {
        0x0000 => "Generic header NACK",
        0x0001 => "Vehicle identification request",
        0x0002 => "Vehicle identification request by EID",
        0x0003 => "Vehicle identification request by VIN",
        0x0004 => "Vehicle announcement",
        0x0005 => "Routing activation request",
        0x0006 => "Routing activation response",
        0x0007 => "Alive check request",
        0x0008 => "Alive check response",
        0x4001 => "Entity status request",
        0x4002 => "Entity status response",
        0x4003 => "Diagnostic power mode request",
        0x4004 => "Diagnostic power mode response",
        0x8001 => "Diagnostic message",
        0x8002 => "Diagnostic message acknowledgement",
        0x8003 => "Diagnostic message negative acknowledgement",
        _ => "Unknown",
    }
}

pub fn build_message(version: u8, payload_type: u16, body: &[u8], out: &mut Vec<u8>) {
    out.push(version);
    out.push(!version);
    out.extend_from_slice(&payload_type.to_be_bytes());
    out.extend_from_slice(&(body.len() as u32).to_be_bytes());
    out.extend_from_slice(body);
}

pub fn uds_sid_name(sid: u8) -> Option<&'static str> {
    match sid {
        0x10 => Some("DiagnosticSessionControl"),
        0x11 => Some("ECUReset"),
        0x14 => Some("ClearDiagnosticInformation"),
        0x19 => Some("ReadDTCInformation"),
        0x22 => Some("ReadDataByIdentifier"),
        0x27 => Some("SecurityAccess"),
        0x28 => Some("CommunicationControl"),
        0x2e => Some("WriteDataByIdentifier"),
        0x31 => Some("RoutineControl"),
        0x34 => Some("RequestDownload"),
        0x36 => Some("TransferData"),
        0x37 => Some("RequestTransferExit"),
        0x3e => Some("TesterPresent"),
        0x85 => Some("ControlDTCSetting"),
        _ => None,
    }
}

pub fn uds_nrc_name(nrc: u8) -> Option<&'static str> {
    match nrc {
        0x10 => Some("generalReject"),
        0x11 => Some("serviceNotSupported"),
        0x12 => Some("subFunctionNotSupported"),
        0x13 => Some("incorrectMessageLengthOrInvalidFormat"),
        0x22 => Some("conditionsNotCorrect"),
        0x31 => Some("requestOutOfRange"),
        0x33 => Some("securityAccessDenied"),
        0x35 => Some("invalidKey"),
        0x78 => Some("requestCorrectlyReceivedResponsePending"),
        0x7e => Some("subFunctionNotSupportedInActiveSession"),
        0x7f => Some("serviceNotSupportedInActiveSession"),
        _ => None,
    }
}

pub fn uds_sid_display(sid: u8) -> Option<(&'static str, bool)> {
    uds_sid_name(sid).map(|name| (name, false)).or_else(|| {
        sid.checked_sub(0x40)
            .and_then(uds_sid_name)
            .map(|name| (name, true))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(ty: u16, body: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        build_message(2, ty, body, &mut out);
        out
    }

    #[test]
    fn byte_exact_header_and_validation() {
        assert_eq!(
            message(0x8001, &[0x0e, 0x80]),
            [2, 0xfd, 0x80, 1, 0, 0, 0, 2, 0x0e, 0x80]
        );
        for n in 0..8 {
            assert_eq!(
                parse_header(&message(1, &[])[..n]),
                Err(ParseError::Truncated)
            );
        }
        let mut bad = message(1, &[]);
        bad[1] = 0;
        assert_eq!(parse_header(&bad), Err(ParseError::Malformed));
        let mut huge = message(1, &[]);
        huge[4..8].copy_from_slice(&((MAX_PAYLOAD_LEN + 1) as u32).to_be_bytes());
        assert_eq!(parse_header(&huge), Err(ParseError::Malformed));
        let mut short = message(2, &[0; 6]);
        short.pop();
        assert_eq!(parse_header(&short), Err(ParseError::Truncated));
        assert!(!plausible(&message(0x1234, &[])));

        let partial = message(0x8001, &[0x0e, 0x80, 0x12, 0x34, 0x3e, 0]);
        assert_eq!(
            parse_header_prefix(&partial[..HEADER_LEN])
                .unwrap()
                .payload_length,
            6
        );
        assert_eq!(
            parse_header(&partial[..HEADER_LEN]),
            Err(ParseError::Truncated)
        );
    }

    #[test]
    fn vectors_cover_every_payload_type() {
        let vin = *b"WVWZZZ1JZXW000001";
        let cases: Vec<(u16, Vec<u8>)> = vec![
            (0x0000, vec![1]),
            (0x0001, vec![]),
            (0x0002, vec![1; 6]),
            (0x0003, vin.to_vec()),
            (
                0x0004,
                [vin.as_slice(), &[0x12, 0x34], &[2; 6], &[3; 6], &[4, 5]].concat(),
            ),
            (0x0005, vec![0x0e, 0x80, 1, 0, 0, 0, 0]),
            (0x0006, vec![0x0e, 0x80, 0x12, 0x34, 0x10, 0, 0, 0, 0]),
            (0x0007, vec![]),
            (0x0008, vec![0x12, 0x34]),
            (0x4001, vec![]),
            (0x4002, vec![1, 2, 1, 0, 0, 0x10, 0]),
            (0x4003, vec![]),
            (0x4004, vec![1]),
            (0x8001, vec![0x0e, 0x80, 0x12, 0x34, 0x3e, 0]),
            (0x8002, vec![0x12, 0x34, 0x0e, 0x80, 0]),
            (0x8003, vec![0x12, 0x34, 0x0e, 0x80, 2]),
        ];
        for (expected_code, (ty, body)) in cases.iter().enumerate() {
            let wire = message(*ty, body);
            let (h, bounded) = parse_header(&wire).unwrap();
            assert_eq!(ty_code(*ty), expected_code as u8);
            assert_eq!(bounded, body);
            parse_payload(h, bounded).unwrap();
            for n in 0..wire.len() {
                assert!(matches!(
                    parse_header(&wire[..n]),
                    Err(ParseError::Truncated) | Err(ParseError::Malformed)
                ));
            }
        }
    }

    #[test]
    fn uds_names_requests_responses_and_nrcs() {
        for sid in [
            0x10, 0x11, 0x14, 0x19, 0x22, 0x27, 0x28, 0x2e, 0x31, 0x34, 0x36, 0x37, 0x3e, 0x85,
        ] {
            assert!(uds_sid_name(sid).is_some());
            assert_eq!(uds_sid_display(sid + 0x40).map(|x| x.1), Some(true));
        }
        for nrc in [
            0x10, 0x11, 0x12, 0x13, 0x22, 0x31, 0x33, 0x35, 0x78, 0x7e, 0x7f,
        ] {
            assert!(uds_nrc_name(nrc).is_some());
        }
        assert_eq!(uds_sid_name(0x7f), None);
    }
}
