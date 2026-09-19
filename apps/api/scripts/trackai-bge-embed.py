#!/usr/bin/env python3
"""Local-only BGE embedding adapter for the Task5 semantic worker.

Customer text is accepted only on stdin and the normalized vector is emitted
as JSON on stdout. Diagnostics never include input text. The model path must
already exist on this deployment; network downloads are disabled.
"""

import argparse
import json
import os
import pathlib
import sys


MODEL_ID = "BAAI/bge-small-en-v1.5"
DIMENSIONS = 384
QUERY_PREFIX = "Represent this sentence for searching relevant passages: "


def fail(message: str) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(2)


def main() -> None:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--model", required=True)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--kind", choices=("document", "query"), required=True)
    parser.add_argument("--dimensions", type=int, required=True)
    arguments = parser.parse_args()

    if arguments.model != MODEL_ID or arguments.dimensions != DIMENSIONS:
        fail("unsupported semantic model contract")
    if os.environ.get("TRACKAI_BGE_ALLOW_REMOTE") != "false":
        fail("remote model access is disabled")
    model_path_value = os.environ.get("TRACKAI_BGE_MODEL_PATH", "").strip()
    if not model_path_value:
        fail("local model path is required")
    model_path = pathlib.Path(model_path_value)
    if not model_path.is_dir():
        fail("local model artifact is unavailable")

    customer_text = sys.stdin.read()
    if not customer_text.strip():
        fail("embedding input is empty")
    encoded_text = QUERY_PREFIX + customer_text if arguments.kind == "query" else customer_text

    try:
        from sentence_transformers import SentenceTransformer

        model = SentenceTransformer(
            str(model_path),
            local_files_only=True,
            trust_remote_code=False,
        )
        vector = model.encode(
            encoded_text,
            normalize_embeddings=True,
            convert_to_numpy=True,
            show_progress_bar=False,
        ).tolist()
    except Exception:
        fail("local semantic inference failed")

    if len(vector) != DIMENSIONS:
        fail("local semantic model returned unexpected dimensions")
    json.dump(vector, sys.stdout, separators=(",", ":"))


if __name__ == "__main__":
    main()
