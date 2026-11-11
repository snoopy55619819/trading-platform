//! Generates Rust types from the published feed schema, `spec/marketdata.proto`.
//!
//! The output lands in Cargo's `OUT_DIR` and is never committed, the same rule as every
//! other generated file in the repo. Compiling the schema with `protox` instead of `protoc`
//! means a fresh checkout builds with nothing but cargo.

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let proto = "../../spec/marketdata.proto";
    println!("cargo:rerun-if-changed={proto}");
    let descriptors = protox::compile([proto], ["../../spec"])?;
    prost_build::Config::new()
        // `bytes::Bytes` would save a copy for byte fields; the schema has none, so the
        // defaults are fine.
        .compile_fds(descriptors)?;
    Ok(())
}
