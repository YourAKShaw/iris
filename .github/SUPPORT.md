# Getting help

Start with the [README](README.md): it covers setup, every configuration variable, provider choices, free deployment and troubleshooting. See [CONTRIBUTING.md](CONTRIBUTING.md) to change the code.

Before opening an issue:

1. Run `iris --version` and `node --version`, and confirm Node.js is 22.12 or later.
2. Re-run the failing command with `IRIS_DEBUG=1` to see operator detail behind the error message.
3. Check the [troubleshooting table](README.md#-troubleshooting).

Search [existing issues](https://github.com/YourAKShaw/iris/issues) first. Use the bug, improvement or documentation form when one fits. For a usage question, open a blank issue with what you ran, what you expected, what happened, your `LLM_PROVIDER` and `LLM_MODEL`, and the target website if it is public.

Never paste API keys, `.env` contents or private URLs. Problems with a provider's quota, key or model availability belong with that provider; include enough context to tell them apart from Iris bugs. Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
