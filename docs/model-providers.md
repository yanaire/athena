# Model providers

Open **Settings → Models & connections**. Save an OpenAI API key or an Anthropic Console key under **Provider credentials**. Other providers listed by Pi may require host configuration. The catalog indicates selectable models; run **Verify** on a saved profile to check streaming and tool calls separately. Selection precedence is conversation, project, then app default.

For a compatible server, choose **Register an OpenAI-compatible endpoint**; enter its base URL, for example `http://127.0.0.1:8080/v1`. Loopback HTTP can be keyless. Remote compatible endpoints require HTTPS and their own key. Make sure it provides `/models`, streaming chat completions, and tool calls. Do not put credentials in URLs.

ChatGPT plan authentication (SIWC) is available only in the [personal local desktop build](installation.md#personal-local-build-with-chatgpt). It uses the selected ChatGPT account's model catalog. If the account is signed in without plan permission, there are no plan models and Athena displays **Enable ChatGPT plan usage**. Existing tokens and runtime environment settings do not enable SIWC in a standard build. Independent Codex OAuth and Claude subscription sign-in remain disabled. An OpenAI API key uses separate authentication and billing. See the [SIWC verification record](m42/siwc.md).
