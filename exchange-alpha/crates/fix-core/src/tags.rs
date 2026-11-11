//! Tag numbers and enumerated values used by the session layer and the gateway.
//!
//! Only what this subset uses. The data dictionary (`spec/fix44.xml`) is the authority on
//! what is valid; these constants just give the numbers readable names.

pub const ACCOUNT: u32 = 1;
pub const AVG_PX: u32 = 6;
pub const BEGIN_SEQ_NO: u32 = 7;
pub const BEGIN_STRING: u32 = 8;
pub const BODY_LENGTH: u32 = 9;
pub const CHECK_SUM: u32 = 10;
pub const CL_ORD_ID: u32 = 11;
pub const COMMISSION: u32 = 12;
pub const COMM_TYPE: u32 = 13;
pub const CUM_QTY: u32 = 14;
pub const CURRENCY: u32 = 15;
pub const END_SEQ_NO: u32 = 16;
pub const EXEC_ID: u32 = 17;
pub const LAST_PX: u32 = 31;
pub const LAST_QTY: u32 = 32;
pub const MSG_SEQ_NUM: u32 = 34;
pub const MSG_TYPE: u32 = 35;
pub const NEW_SEQ_NO: u32 = 36;
pub const ORDER_ID: u32 = 37;
pub const ORDER_QTY: u32 = 38;
pub const ORD_STATUS: u32 = 39;
pub const ORD_TYPE: u32 = 40;
pub const ORIG_CL_ORD_ID: u32 = 41;
pub const POSS_DUP_FLAG: u32 = 43;
pub const PRICE: u32 = 44;
pub const REF_SEQ_NUM: u32 = 45;
pub const SENDER_COMP_ID: u32 = 49;
pub const SENDING_TIME: u32 = 52;
pub const SIDE: u32 = 54;
pub const SYMBOL: u32 = 55;
pub const TARGET_COMP_ID: u32 = 56;
pub const TEXT: u32 = 58;
pub const TIME_IN_FORCE: u32 = 59;
pub const TRANSACT_TIME: u32 = 60;
pub const POSS_RESEND: u32 = 97;
pub const ENCRYPT_METHOD: u32 = 98;
pub const CXL_REJ_REASON: u32 = 102;
pub const ORD_REJ_REASON: u32 = 103;
pub const HEART_BT_INT: u32 = 108;
pub const TEST_REQ_ID: u32 = 112;
pub const ORIG_SENDING_TIME: u32 = 122;
pub const GAP_FILL_FLAG: u32 = 123;
pub const RESET_SEQ_NUM_FLAG: u32 = 141;
pub const EXEC_TYPE: u32 = 150;
pub const LEAVES_QTY: u32 = 151;
pub const SECURITY_EXCHANGE: u32 = 207;
pub const REF_TAG_ID: u32 = 371;
pub const REF_MSG_TYPE: u32 = 372;
pub const SESSION_REJECT_REASON: u32 = 373;
pub const CXL_REJ_RESPONSE_TO: u32 = 434;
pub const LAST_LIQUIDITY_IND: u32 = 851;

/// `MsgType(35)` values.
pub mod msg_type {
    pub const HEARTBEAT: &str = "0";
    pub const TEST_REQUEST: &str = "1";
    pub const RESEND_REQUEST: &str = "2";
    pub const REJECT: &str = "3";
    pub const SEQUENCE_RESET: &str = "4";
    pub const LOGOUT: &str = "5";
    pub const EXECUTION_REPORT: &str = "8";
    pub const ORDER_CANCEL_REJECT: &str = "9";
    pub const LOGON: &str = "A";
    pub const NEW_ORDER_SINGLE: &str = "D";
    pub const ORDER_CANCEL_REQUEST: &str = "F";

    /// Session-layer ("admin") messages. On a resend these are never replayed; the gap they
    /// leave is covered by a `SequenceReset` gap fill instead.
    pub fn is_admin(msg_type: &str) -> bool {
        matches!(
            msg_type,
            HEARTBEAT | TEST_REQUEST | RESEND_REQUEST | REJECT | SEQUENCE_RESET | LOGOUT | LOGON
        )
    }
}

/// `SessionRejectReason(373)` values, restricted to those the dictionary allows.
pub mod session_reject_reason {
    pub const INVALID_TAG_NUMBER: u32 = 0;
    pub const REQUIRED_TAG_MISSING: u32 = 1;
    pub const TAG_NOT_DEFINED_FOR_MESSAGE_TYPE: u32 = 2;
    pub const VALUE_IS_INCORRECT: u32 = 5;
    pub const INCORRECT_DATA_FORMAT: u32 = 6;
    pub const COMP_ID_PROBLEM: u32 = 9;
    pub const SENDING_TIME_ACCURACY_PROBLEM: u32 = 10;
    pub const INVALID_MSG_TYPE: u32 = 11;
}
