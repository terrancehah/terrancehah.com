# Minimal shim to satisfy Langfuse's `import langchain` version check.
# Langfuse only needs langchain.__version__ to determine the import path;
# all actual functionality comes from langchain_core (installed separately).
# This avoids installing the full langchain package and its heavy dependencies
# (langgraph, langgraph-sdk, etc.) which exceed Vercel's 245 MB Lambda limit.
__version__ = "1.0.0"
