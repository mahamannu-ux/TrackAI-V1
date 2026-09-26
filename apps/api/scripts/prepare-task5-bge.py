#!/usr/bin/env python3
"""Prepare and verify the immutable local BGE artifact used by Task5 CI."""

import argparse
import hashlib
import pathlib

from huggingface_hub import snapshot_download


MODEL_ID = "BAAI/bge-small-en-v1.5"
REVISION = "5c38ec7c405ec4b44b94cc5a9bb96e735b38267a"
WEIGHTS_SHA256 = "3c9f31665447c8911517620762200d2245a2518d6e7208acc78cd9db317e21ad"
REQUIRED_FILES = (
    "1_Pooling/config.json",
    "config.json",
    "config_sentence_transformers.json",
    "model.safetensors",
    "modules.json",
    "sentence_bert_config.json",
    "special_tokens_map.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "vocab.txt",
)


def sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    arguments = parser.parse_args()
    output = pathlib.Path(arguments.output).resolve()
    if output == pathlib.Path(output.anchor):
        raise SystemExit("refusing to use a filesystem root as the model directory")

    weights = output / "model.safetensors"
    revision_marker = output / ".trackai-revision"
    ready = (
        all((output / name).is_file() for name in REQUIRED_FILES)
        and revision_marker.is_file()
        and revision_marker.read_text(encoding="utf-8").strip() == REVISION
        and sha256(weights) == WEIGHTS_SHA256
    )
    if not ready:
        snapshot_download(
            repo_id=MODEL_ID,
            revision=REVISION,
            local_dir=str(output),
            allow_patterns=list(REQUIRED_FILES),
        )
        output.mkdir(parents=True, exist_ok=True)
        revision_marker.write_text(f"{REVISION}\n", encoding="utf-8")

    missing = [name for name in REQUIRED_FILES if not (output / name).is_file()]
    if missing:
        raise SystemExit("pinned semantic artifact is incomplete")
    if sha256(weights) != WEIGHTS_SHA256:
        raise SystemExit("pinned semantic weights checksum mismatch")
    if revision_marker.read_text(encoding="utf-8").strip() != REVISION:
        raise SystemExit("pinned semantic revision marker mismatch")
    print("task5_bge_artifact=verified")


if __name__ == "__main__":
    main()
