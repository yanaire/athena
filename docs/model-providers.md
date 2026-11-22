# Model providers

Open **Settings → Models & connections**. Save an OpenAI API key or an Anthropic Console key under **Provider credentials**. Other providers listed by Pi may require host configuration. The catalog indicates selectable models; run **Verify** on a saved profile to check streaming and tool calls separately. Selection precedence is conversation, project, then app default.

For a compatible server, choose **Register an OpenAI-compatible endpoint**; enter its base URL, for example `http://127.0.0.1:8080/v1`. Loopback HTTP can be keyless. Remote compatible endpoints require HTTPS and their own key. Make sure it provides `/models`, streaming chat completions, and tool calls. Do not put credentials in URLs.

ChatGPT plan authentication (SIWC), independent Codex OAuth, and Claude subscription sign-in are disabled in this distribution. Existing tokens and environment settings do not enable them. An OpenAI API key is a separate authentication and billing path. See the [SIWC verification record](m42/siwc.md).
