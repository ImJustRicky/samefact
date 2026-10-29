"""Mem0 (open-source library) over MCP, for samefact.

Mem0's own MCP servers need its cloud API or OpenMemory's Docker stack, so
this wraps the open-source library directly with the configuration its
docs describe for local use: an OpenAI-compatible LLM (SAMEFACT_LLM_URL,
SAMEFACT_LLM_MODEL), fastembed embeddings and an in-memory Qdrant store.
Every add goes through Mem0's LLM step, which extracts facts and decides
whether to add, update or delete memories.
"""

import os
import shutil
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor

from mcp.server.fastmcp import FastMCP

USER = "samefact"
tmp = tempfile.mkdtemp(prefix="samefact-mem0-")
# Start from a snapshot of another run's storage (see the snapshot tool),
# so the same background notes aren't stored twice.
if os.environ.get("SAMEFACT_MEM0_FROM"):
    shutil.copytree(os.environ["SAMEFACT_MEM0_FROM"], tmp, dirs_exist_ok=True)
# Mem0 keeps its own state in ~/.mem0 by default, shared by every process;
# give each run its own, so runs can go side by side and the real home
# folder is never touched.
os.environ["MEM0_DIR"] = os.path.join(tmp, "mem0-home")

from mem0 import Memory  # noqa: E402  (after MEM0_DIR is set)

memory = Memory.from_config(
    {
        "llm": {
            "provider": "openai",
            "config": {
                "model": os.environ.get("SAMEFACT_LLM_MODEL", "gpt-4o-mini"),
                "openai_base_url": os.environ.get("SAMEFACT_LLM_URL"),
                "api_key": os.environ.get("SAMEFACT_LLM_KEY", "local"),
                "temperature": 0,
                "max_tokens": 1000,
            },
        },
        "embedder": {
            "provider": "fastembed",
            "config": {"model": "BAAI/bge-small-en-v1.5", "embedding_dims": 384},
        },
        "vector_store": {
            "provider": "qdrant",
            "config": {
                "collection_name": "samefact",
                "path": os.path.join(tmp, "qdrant"),
                "embedding_model_dims": 384,
                "on_disk": False,
            },
        },
        "history_db_path": os.path.join(tmp, "history.db"),
    }
)

# Mem0's local stores (in-process Qdrant, SQLite history) aren't safe to
# use from several threads at once. Storage calls go through one lock, so
# only the LLM calls overlap when notes are added concurrently.
_lock = threading.RLock()


STORE_METHODS = [
    "insert", "search", "search_batch", "keyword_search", "delete",
    "update", "get", "list", "create_col", "delete_col", "col_info", "reset",
]
DB_METHODS = [
    "add_history", "batch_add_history", "get_history", "save_messages",
    "get_last_messages",
]


def _serialize(obj, names):
    for name in names:
        method = getattr(obj, name, None)
        if method is None:
            continue

        def locked(*args, _f=method, **kwargs):
            with _lock:
                return _f(*args, **kwargs)

        setattr(obj, name, locked)


_serialize(memory.vector_store, STORE_METHODS)
if getattr(memory, "db", None) is not None:
    _serialize(memory.db, DB_METHODS)

server = FastMCP("mem0-oss")


@server.tool()
def add_memory(text: str) -> str:
    """Remember something the user said."""
    # A failed add (the LLM step can fail on odd notes) means the note isn't
    # stored, which is what a user would get; samefact counts it that way.
    try:
        result = memory.add(text, user_id=USER)
    except Exception as error:  # noqa: BLE001
        return f"error {type(error).__name__}: {str(error)[:200]}"
    items = result.get("results", []) if isinstance(result, dict) else result
    events = [r.get("event") for r in (items or []) if isinstance(r, dict)]
    return f"ok {events}"


@server.tool()
def add_memories(texts: list[str], workers: int = 4) -> str:
    """Remember several unrelated things at once (order among them doesn't
    matter). Each goes through add_memory; the LLM calls overlap."""
    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        results = list(pool.map(add_memory, texts))
    errors = [r for r in results if r.startswith("error")]
    return f"ok {len(results) - len(errors)} added, {len(errors)} errors"


@server.tool()
def snapshot() -> str:
    """Copy this memory's storage and return the folder, to start another
    run from the same state (SAMEFACT_MEM0_FROM)."""
    with _lock:
        dest = tempfile.mkdtemp(prefix="samefact-mem0-snap-")
        shutil.copytree(tmp, dest, dirs_exist_ok=True)
    return dest


@server.tool()
def search_memories(query: str, limit: int = 5) -> dict:
    """Search memories, best first."""
    found = memory.search(query, filters={"user_id": USER}, top_k=limit)
    return {"results": [{"memory": r["memory"]} for r in found.get("results", [])]}


if __name__ == "__main__":
    server.run()
