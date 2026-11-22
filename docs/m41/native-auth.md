# M4.1 · Pi 인증과 macOS 키체인

`Athena.app`을 Finder에서 연 뒤 **Settings → Models & connections**로 이동한다. 이 빌드에는 Node 24.22.3과 Pi 1.5.2가 들어 있다. **Provider credentials**에서 키를 등록하거나 변경하고, **Model catalog**에서 조회한 모델을 프로필로 저장한다. 카탈로그에 나타나는 것만으로 계정의 추론 권한이 확인되지는 않는다. 저장한 프로필의 **Verify**에서 스트리밍과 도구 호출 결과를 따로 확인한다.

## 키체인과 복구

Athena는 작업공간을 잠근 뒤 `Athena provider vault v1` 서비스에서 정규 작업공간 경로의 SHA-256을 계정명으로 사용한다. 보관소도 키도 없는 작업공간에는 Security.framework로 임의 256비트 키를 추가하고, 다시 읽은 값이 일치할 때만 `provider-secrets.v1`을 초기화한다. Settings에서 `Keychain-backed vault · saved across restarts`를 확인할 수 있다. 보관소는 0600 권한의 AES-256-GCM 파일이다. Rust는 키를 자식 Node의 stdin으로만 넘긴다. 키체인은 보관소 암호화 키를 관리하고, 제공자 API 키와 토큰은 암호화 파일에 저장된다.

macOS가 잠금 해제나 접근 승인을 요구하면 운영체제 대화상자를 사용한다. 기존 보관소의 키가 없거나 승인이 거부되면 앱은 시작을 중단하고 보관소를 유지한다. 기존 운영자 키로 만든 보관소는 같은 원래 키가 필요하다. v1 구조 손상은 별도로 보고하지만, 같은 길이의 암호문 변조와 원래 키가 아닌 경우에는 같은 인증 실패가 발생한다. 이 경우 원래 보관소와 키를 함께 복구한다. 데스크톱은 메모리 저장으로 자동 전환하지 않는다. 키가 없고 기존 보관소도 없는 CLI 작업공간의 메모리 모드는 이전과 같다.

## 제공자 상태

아래는 설치된 Pi가 돌려준 43개 제공자의 분류다. 런타임에서 같은 목록을 별도로 관리하지 않는다. OAuth의 브라우저·디바이스 구분은 Pi의 실제 상호작용 유형을 기준으로 표시한다. OAuth 메서드 표시와 이 배포의 로그인 허용 여부는 별개다.

| 제공자 | 이 배포에서 쓰는 인증과 검증 범위 |
|---|---|
| OpenAI | Pi의 OpenAI API 키. 공식 URL·스트리밍·도구 호출은 통제 수송으로 확인했다. ChatGPT 플랜 OAuth는 비활성이다. |
| Anthropic | Claude Console API 키. 공식 URL·스트리밍·도구 호출은 통제 수송으로 확인했다. Claude 구독 OAuth는 비활성이다. |
| Gemini, OpenCode Zen/Go, DeepSeek, Groq, xAI, Mistral, NVIDIA | 각 Pi 제공자에 API 키를 등록하는 경로를 확인했다. 실계정 추론은 실행하지 않았다. xAI의 디바이스 OAuth는 비활성이다. |
| OpenRouter, GitHub Copilot | Pi가 등록한 OpenRouter 키 및 Copilot 토큰 입력. [OpenRouter PKCE](https://openrouter.ai/docs/guides/overview/auth/oauth)는 문서와 SDK를 대조했으나 이 빌드의 루프백 로그인·권한 확인을 완료하지 않았다. Copilot은 허용된 앱 등록을 확인하지 않았다. 두 OAuth는 비활성이다. |
| Bedrock, Vertex AI, Azure OpenAI, Cloudflare AI Gateway, Cloudflare Workers AI | 호스트 자격 증명과 별도 설정 필요. Settings에서 일반 키 입력을 제공하지 않는다. 클라우드 실계정은 미검증이다. Docker 분석 CLI와 분석 컨테이너에 호스트 환경 전체를 전달하지 않는다. |
| Kimi Coding, Meta, Radius | Pi의 API 키 입력. SDK가 제공하는 OAuth는 이 배포에서 비활성이다. |
| 독립 `openai-codex` | 브라우저 또는 디바이스 인증이 SDK에 있으나 Athena 등록 권한이 없어 로그인과 실행을 차단한다. |
| 그 외 SDK 제공자 | `ant-ling`, `baseten`, `cerebras`, `fireworks`, `huggingface`, MiniMax 2종, Moonshot 2종, Qwen Token Plan 4종, Together, Typesafe, Vercel AI Gateway, Xiaomi 4종, Z.ai 2종의 Pi API 키 입력. 공급자별 실계정은 미검증이다. |
| 로컬·호환 서버 | 루프백은 키 없이 사용 가능하다. 원격 호환 서버는 HTTPS와 해당 서버 키가 필요하다. 카탈로그에서 엔드포인트 출처를 표시한다. |

## ChatGPT 계정 수명주기

기존 Pi `ModelRuntime.login`과 `CredentialStore`로 [공식 SIWC](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)를 연결했다. 새 등록은 `dynamic_agent_client`, 재인증은 해당 등록에 발급된 client ID를 쓴다. 호스트 ID를 고정하고 시도마다 PKCE, state, nonce를 생성한다. 콜백과 OpenAI JWKS의 서명, issuer·audience·subject·만료·nonce 및 직접 사용 scope를 검증한 뒤 저장한다. 시스템 브라우저 URL과 반환 로그인용 ID 토큰 힌트는 호스트에서만 다룬다. WebView에는 브라우저를 열 수 있는 상태와 흐름 ID만 전한다.

검증된 계정과 발급 client ID로 등록을 구분한다. 이메일이 같아도, 워크스페이스가 다른 별도 등록이면 합치지 않는다. 기존 단일 등록 참조는 계속 읽을 수 있다. 성공한 재인증은 등록별 레코드를 쓰고, API 키는 별도 경로를 유지한다. 목록과 실행은 선택한 참조로만 토큰을 읽고, 계정 목록에서 모델을 확인하지 못하면 추론을 시작하지 않는다. 실행 시 부모·자식은 같은 제공자, 모델, 엔드포인트, 계정 참조, 프로필 리비전 및 추론 수준을 공유한다. 기본 모델을 바꿔도 현재 실행에는 영향을 주지 않는다.

로그아웃은 선택한 등록의 갱신 세션만 공식 발견 문서의 철회 URL로 요청한 뒤 토큰을 삭제한다. 네트워크 오류와 서버 오류는 제한 시간 안에서 재시도한다. 철회를 확인하지 못해도 로컬 토큰은 지우고 별도 경고를 표시한다. 이후 [ChatGPT 설정](https://chatgpt.com/settings/usage)에서 접근을 해제할 수 있다. 계정과 발급 client ID의 연결은 재인증에 사용하도록 남는다.

**이 배포에는 ChatGPT 실로그인이 없다.** `yanaire/athena-1`은 확인 당시 비공개였고 등록된 라이선스와 이 배포의 OpenAI 자격을 확인하지 못했다. 현재 앱, 환경 설정, 로컬 RPC로 비활성 경로를 켤 수 없다. 다른 앱의 클라이언트 ID와 토큰을 사용하지 않았다. [M3.1 실계정 인수 7개](../m31/chatgpt-codex.md#pending--공개-요건과-실계정-인수)는 모두 Pending이다. OpenAI가 실제 등록에 반환한 Codex 슬러그만 계정 프로필에서 선택할 수 있으며, 추론은 같은 공식 OpenAI Responses 경로를 사용한다.

## 검증 증거

| 확인한 경로 | 관찰한 결과 |
|---|---|
| 실제 Finder와 로그인 키체인 | 별도 서명한 `Athena Auth QA.app`을 Finder에서 열어 실제 로그인 키체인 항목이 등록된 것을 비밀값 출력 없이 확인했다. UI에서 로컬 테스트용 API 키를 저장하자 보관소가 30바이트에서 136바이트로 늘어났고 권한 0600을 유지했다. 정상 종료 후 기존 앱(7653), Node(7670), 수신 포트(58143)가 사라졌다. 같은 앱을 Launch Services로 재실행해 새 앱(20763), 새 Node(20768), `Host vault · keychain` 및 기존 엔드포인트 `Keychain QA endpoint`를 확인했다. 저장 후와 재실행 후 보관소 SHA-256은 `e7b1ab7a16d5bda0d9305d59e1ef4fb13833d1a0cbaa50ea2f74ac081f989a2a`로 같았다. 이 격리 앱에는 최종 배포 번들과 다른 일부 UI·런타임 리소스가 있다. 로컬 증거: `~/.athena/evidence/m41-keychain-O08ZZi/`. |
| 서명된 번들에서 인증 저장·복원 | `npm run desktop:build`가 ad-hoc 서명, 번들 의존성·아키텍처 검증을 통과했다. 번들 Node에 테스트 키를 stdin으로 넣고 인증된 API에서 엔드포인트와 키를 저장했다. 완전히 종료한 뒤 새 Node에서 프로필을 복원했다. 올바른 Bearer가 없으면 거부하는 로컬 서버가 복원된 키의 스트리밍·도구 요청을 수락했다. 보관소 바이트는 재시작으로 변하지 않았으며 응답과 파일에 키 문자열이 없었다. 이 검사는 OS 키체인 재조회 검사가 아니다. |
| 키 재입력 없는 카탈로그 갱신 | 재실행된 `Athena Auth QA.app`의 **Refresh** 한 번으로 로컬 서버의 `AUTH_MODELS_OK`와 UI의 `Refreshed catalog` 및 `keychain-fixture` 표시를 함께 확인했다. 테스트 키를 다시 입력하지 않았으며 보관소의 해시와 권한은 그대로였다. 이 경로에서 확인한 것은 모델 목록 인증이다. |
| 키 누락과 강제 종료 | 격리 QA 앱의 Node(20768)를 강제 종료하자 해당 프로세스와 포트(58579)가 사라졌고 보관소의 해시가 유지됐다. 최종 서명 앱은 별도의 기존 보관소 복사본에 대응하는 키체인 항목이 없을 때 `An existing Athena vault has no matching Keychain entry`를 표시했다. Node는 종료됐고 복사본은 0600과 동일한 바이트를 유지했다. 잘못된 키와 구조 손상은 데스크톱 호스트 회귀에서도 확인했다. |
| 실제 Qwen 부모·자식 | 번들의 Sidecar와 실제 로컬 Qwen3 4B에 연결했다. 실행 `a7aee824-133b-45b5-8c1a-6364ae605a6d`에서 텍스트 델타 27개와 독립 자식 `01a1f8b3-a567-754c-80d4-aeec4b8b71cf`을 확인했다. 부모와 자식 모두 동일 프로필 리비전 1·엔드포인트·키 없음 참조를 기록했다. Sidecar 재시작 뒤 시도 기록 일치와 자식 이력 SHA-256 `b32fc7d9228bc07c5a3a01e36d1e528f52c30a7538cc31bb84d1aa14ca0e1880`을 확인했다. 증거: `~/.athena/evidence/m41-live-pq9EKr/receipt.json`. |
| ChatGPT 통제 테스트 | 실제 루프백 콜백과 서명된 통제 토큰, 같은 이메일의 두 등록, 저장된 API 키 보존, 등록별 목록 접근, 힌트 비공개, 토큰 갱신 및 철회 실패를 확인했다. 계정 모델 슬러그로 실제 Pi 부모·자식을 구동했으며 서비스 응답은 공식 형식의 통제 수송이었다. |
| OAuth 취소 통제 테스트 | 올바른 state의 `access_denied` 콜백은 코드 교환 없이 거부됐고 기존 키가 유지됐다. 취소 중인 토큰 교환은 중단됐고 컨트롤러 종료 시 콜백 포트와 로그인 상태가 정리됐다. |
| 배포 차단과 기존 OAuth 보관소 | 데스크톱 호스트를 통제 암호화 키와 기존 OAuth 보관소로 시작했다. 계정 목록·카탈로그 조회에서 토큰을 사용하지 않았고, 로그인·브라우저 열기·철회를 차단했다. 네트워크 통신, 진단·응답에 비밀값 노출, 보관소 쓰기가 없었으며 다시 열었을 때 기존 토큰 세트가 남아 있었다. 실제 OS 키체인과 승인된 실계정 OAuth를 결합한 검사는 아니다. |
| 기존 연구와 Docker | 로컬 고정 Docker 이미지로 별도 11건을 통과했다. Pi 도구, 프로젝트 격리, CSV, 독립 자식, 분석 취소, 복원한 아티팩트와 저장 SHA-256을 확인했다. Docker 기능을 제거하지 않았다. |

최종 타입 검사와 고정 Docker 이미지를 사용한 Node 테스트 117건, UI·SDK 계약 테스트 71건이 모두 통과했다. UI 계약 검사는 LinkeDOM 결과이며 Finder 브라우저 검사와 별개다.

**미검증:** 실제 키체인 잠금·Athena 접근 승인 거부·키 저장 실패는 유발하지 않았다. 배포 자격이 확인될 때까지 실제 ChatGPT 계정 연결, Finder 앱에서 시스템 브라우저로 넘어가는 OpenAI 콜백, 로그인 중 앱 종료 인수는 Pending이다. 원격 OpenAI·Anthropic·기타 실계정 키를 사용하지 않았다.

로컬 빌드 경로는 `src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Athena.app`이다. 바이너리·QA 기록·비밀값은 Git에 넣지 않는다. Node 배포 라이선스, npm upstream 고지, 잠금 파일 출처를 유지했다. Developer ID 서명·공증, 다른 Mac의 Gatekeeper 통과 및 외부 배포 라이선스 검토는 별도다.
