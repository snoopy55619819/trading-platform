//! The Postgres session store against a real database. Runs only when
//! `ALPHA_TEST_DATABASE_URL` is set (the exchange's local database works:
//! `postgres://exchange_alpha:exchange_alpha@127.0.0.1:5433/exchange_alpha`); otherwise it
//! passes without checking anything, so `cargo test` needs no database.

use fix_core::Changes;
use gateway::{PgStore, SessionStore};

fn changes(next_out_seq: u64, reset: bool, new: &[u64], forget_below: Option<u64>) -> Changes {
    Changes {
        next_in_seq: 7,
        next_out_seq,
        reset,
        new_outbound: new
            .iter()
            .map(|seq| (*seq, format!("message {seq}").into_bytes()))
            .collect(),
        forget_below,
    }
}

#[tokio::test]
async fn saves_a_batch_of_messages_in_one_go_and_forgets_below_the_window() {
    let Ok(url) = std::env::var("ALPHA_TEST_DATABASE_URL") else {
        eprintln!("ALPHA_TEST_DATABASE_URL not set; skipping");
        return;
    };
    let mut store = PgStore::connect(&url).await.unwrap();
    let comp_id = format!("TEST-{}", std::process::id());

    // A reset, then a batch of 300 messages, as one save.
    let batch: Vec<u64> = (1..=300).collect();
    store
        .save(&comp_id, &changes(301, true, &batch, None))
        .await
        .unwrap();
    // The next batch, with the oldest fallen out of the window.
    store
        .save(&comp_id, &changes(303, false, &[301, 302], Some(101)))
        .await
        .unwrap();

    let saved = store.load_all().await.unwrap();
    let session = saved.iter().find(|s| s.comp_id == comp_id).unwrap();
    assert_eq!((session.next_in_seq, session.next_out_seq), (7, 303));
    let seqs: Vec<u64> = session.outbound.iter().map(|(seq, _)| *seq).collect();
    assert_eq!(seqs, (101..=302).collect::<Vec<_>>());
    assert_eq!(session.outbound[0].1, b"message 101");

    // A reset clears what was kept before it, in the same save as the new messages.
    store
        .save(&comp_id, &changes(2, true, &[1], None))
        .await
        .unwrap();
    let saved = store.load_all().await.unwrap();
    let session = saved.iter().find(|s| s.comp_id == comp_id).unwrap();
    assert_eq!(session.outbound, vec![(1, b"message 1".to_vec())]);

    // Leave the database as it was: a reset with nothing new, then the session row.
    store
        .save(&comp_id, &changes(1, true, &[], None))
        .await
        .unwrap();
    let pool = sqlx::PgPool::connect(&url).await.unwrap();
    sqlx::query("DELETE FROM fix_sessions WHERE comp_id = $1")
        .bind(&comp_id)
        .execute(&pool)
        .await
        .unwrap();
}
