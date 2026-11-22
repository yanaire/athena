# Athena M3 인수 기록

기준: `feature/athena-m2-general-execution`의 `7e63963ff4683daaaaa7982e932ea652d5c494d8`. 실행과 저장은 Athena TaskManager와 Pi SDK 1.5.2를 사용한다. 설정 방법은 [setup.md](setup.md)에 있다.

| 검증 구분 | 결과 | 근거 |
|---|---|---|
| Chrome + 실제 1.7B | 저장한 `Qwen Small 1.7B`을 채팅에서 선택해 `SMALL-EMBER` 응답을 받았다. 실행 `b8b42e3c-308e-4258-9873-16d79289dc04`, 실제 모델 `m1-qwen3-1.7b`, `127.0.0.1:62382/v1`. | `model-identities.json`, `62382.log`, Pi JSONL |
| Chrome + 실제 4B | `Qwen Analysis 4B`는 별도 `127.0.0.1:62381/v1`의 `athena-qwen3-4b-instruct`를 사용했다. 실행 `44507c17-76f5-4c50-8570-199ed65a01f6`의 부모와 두 독립 자식 모두 프로필 `ac43ed7f-013b-46c0-8895-e614dc14f02c` 리비전 1을 사용했다. | `settling-pre.json`, `62381.log`, Pi JSONL |
| 실제 코드 및 Docker | 자식이 작성한 `analysis.py`를 `/usr/bin/python3 -I -B /workspace/analysis.py`로 실행했다. 첫 실행은 Python 오류로 종료 코드 1이었다. 부모가 수정 요청을 보낸 뒤 두 번째 실행이 0으로 종료했다. 부모가 `clean.csv`와 `result.json`을 ID로 각각 읽은 뒤 답했다. | `settling-pre.json`, `verify-pre.log` |
| 독립 계산 | 원본에서 T2를 제외하면 6, 12, 18, 24 ms이다. 중앙값 15 ms, 모집단 표준편차 √45 = 6.708203932499369 ms. Chrome 다운로드와 저장된 해시를 `scripts/m21-browser-verify.mjs`로 대조했다. | `verify-pre.log`, `verify-post.log` |
| 실제 호스트 재시작 | 같은 저장소를 PID 71713에서 76670으로 다시 열었다. 실행과 Pi 기록을 다시 확인했으며, 분석 파일 세 개를 Chrome에서 새로 다운로드해 검증했다. 실행 저널 SHA-256 `3acb5fd8269c4b5735679a3be202a6a88a5fdedb122b84b423cb1372f66870df`. | `restart.json`, `settling-post.json`, `verify-post.log` |
| 통제 OpenAI 및 Anthropic | Pi가 OpenAI Responses의 `Authorization` 및 Anthropic Messages의 `x-api-key`를 해당 제공자에만 전송했다. 401/403/404/429 구분, 실제 SDK SSE 파싱, 도구 확인의 독립 상태를 검사했다. | `tests/provider-manager.test.ts` |
| 통제 ChatGPT OAuth | PKCE·콜백·JWT 검증, 취소, 만료와 토큰 회전, 저장 실패, 암호화 저장소 재열기, 로그아웃 후 재열기를 검사했다. 실제 OpenAI 계정에 로그인하지 않았다. | `tests/provider-oauth.test.ts` |
| 통제 실행·저장 | 부모 실행 중 프로필을 수정하고 대화 선택을 바꿔도 부모·자식의 원래 HTTP 목적지·모델·키·리비전이 고정되고 다음 실행에 변경이 반영된다. 분할된 자격 증명 문자열이 공개 이벤트와 Pi JSONL·SQLite에 남지 않는지 검사했다. | `tests/model-profiles.test.ts` |

| Chrome 다운로드 | 크기 | 재시작 전후 같은 SHA-256 |
|---|---:|---|
| `analysis.py` | 1395 B | `2205d2e850164bccea6463fd1d64bdf529ea8f8b9aa1b7322caf58e0f426a9c5` |
| `clean.csv` | 54 B | `de4abe8cfcb956f3ea5d99eb7fac8771d8dd99323b7d833f1bd53be3f762363a` |
| `result.json` | 52 B | `0e130c13b82a29b2a4506e24e81f88d900a970786915c096d5c43b1cf1031ab0` |

로컬 Chrome 증거는 `~/.athena/evidence/m3-chrome-WFQUPG/`에 보관했다. 초기 4B 실행 `13db2861-6129-4eed-9edf-7e8cc50e50e9`는 프로젝트에 Docker가 허용되지 않아 고정 CSV 도구만 실행했다. 그 실행은 모델 선택 증거로만 사용했고 Docker 인수에 포함하지 않았다.

부모의 최종 답변은 CSV와 JSON을 인용했으며 `analysis.py` 주소는 포함하지 않았다. 소스 파일은 UI의 Artifacts에서 내려받았다. 마지막 빌드에서는 재시작 후 대화를 여는 즉시 `Qwen Analysis 4B`와 `Reasoning · Off`가 복원되는 것도 데스크톱(1440 × 900)과 모바일(390 × 844) Chrome에서 확인했다.

회귀: `npm run check`, Docker 이미지를 지정한 백엔드 테스트 68/68, DOM 통합 103/103, 모델 프로필·런타임·어댑터·워크스페이스 계약 70/70.

Pi 런타임에서 확인한 내장 제공자 ID 43개: `amazon-bedrock`, `ant-ling`, `anthropic`, `azure`, `baseten`, `cerebras`, `cloudflare-ai-gateway`, `cloudflare-workers-ai`, `deepseek`, `fireworks`, `github-copilot`, `google`, `google-vertex`, `groq`, `huggingface`, `kimi-coding`, `meta`, `minimax`, `minimax-cn`, `mistral`, `moonshotai`, `moonshotai-cn`, `nvidia`, `openai`, `openai-codex`, `opencode`, `opencode-go`, `openrouter`, `qwen-token-plan`, `qwen-token-plan-cn`, `qwen-token-plan-individual`, `qwen-token-plan-individual-cn`, `radius`, `together`, `typesafe`, `vercel-ai-gateway`, `xai`, `xiaomi`, `xiaomi-token-plan-ams`, `xiaomi-token-plan-cn`, `xiaomi-token-plan-sgp`, `zai`, `zai-coding-cn`. 이 목록은 인수 시점의 출력이다. 구현은 설치한 SDK에서 발견한다. Chrome 검증에서 두 호환 서버를 등록하자 45개가 표시됐다.

실제 OpenAI API 키, 실제 ChatGPT 계정, 실제 Claude Console 키, 클라우드 계정, 외부 HTTPS 호환 서버, 운영자의 macOS Keychain 등록은 이 환경에서 확인하지 않았다. `openai-codex` OAuth는 재사용이 승인된 Athena 클라이언트가 없어 미구현이다. Claude 구독 OAuth는 정책상 숨겼다. 그 밖의 OAuth는 각 카드에 비활성 사유를 표시한다.
