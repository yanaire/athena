# Athena M3.1 · ChatGPT 플랜과 Codex 모델

이 배포에서 **ChatGPT 플랜 로그인과 `openai-codex` OAuth는 비활성화**되어 있다. OpenAI API 키 경로는 그대로 사용할 수 있다. 아래의 계정 연결과 Pi 실행은 통제 테스트에서 검증한 경로다.

| 경로 | 모델 목록과 실행 |
|---|---|
| `openai` · API 키 | Pi의 OpenAI API 키 경로와 SDK 카탈로그. 모델 등록은 계정의 실행 권한을 보장하지 않는다. 기존 프로필을 그대로 쓴다. |
| `openai` · ChatGPT 플랜 | OpenAI가 해당 Athena 등록에 발급한 OAuth 액세스 토큰으로 `GET https://api.openai.com/v1/models`를 호출한다. `visibility: "list"`인 항목의 표시 이름과 슬러그를 사용한다. Codex가 반환될 때만 목록에 나타난다. 이 배포에서는 비활성화했다. |
| `openai-codex` · 독립 OAuth | Pi 목록에 제공자 이름은 남는다. Athena가 사용할 수 있는 독립 클라이언트 등록이 없어 로그인과 실행을 막는다. |

계정 프로필에는 자격 증명 대신 등록을 식별하는 불투명한 참조가 남는다. 호스트는 프로필을 저장하고 실행을 시작할 때 계정과 모델을 다시 확인한다. 계정 변경이나 목록 조회 실패 시 SDK 목록, 다른 모델, API 키로 대체하지 않는다. 부모와 자식은 동일한 프로필 리비전, 모델 슬러그, 엔드포인트를 사용한다. 추론은 `POST https://api.openai.com/v1/responses`의 SSE를 사용하고, `store: false`와 `stream: true`를 설정한다. Athena 도구는 요청의 `additional_tools`에 선언하고 로컬에서 실행한다. 작업과 대화는 Athena에 저장한다.

## 통제 검증

- `node --test tests/chatgpt-account.test.ts`: 실제 Pi 부모가 `spawn_agent`와 `wait_for_agents`를 호출하고 독립 자식의 결과를 받아 답한다. OpenAI에 연결하는 대신 공식 요청과 응답 형식을 검증하는 수송을 사용한다. 실행에서 선택한 슬러그와 프로필을 확인하고 암호화 보관소와 기록을 다시 연다.
- `node --test tests/provider-oauth.test.ts tests/provider-manager.test.ts`: OAuth 권한, 콜백, 만료·회전·취소·실패, 제공자 목록, OpenAI 및 Anthropic API 키를 통제 환경에서 확인한다.
- `node athena-backend-handoff/athena-codex-ui/qa/model-profiles-test.cjs`: 계정 카탈로그와 채팅 선택기의 표시, 계정이 바뀐 프로필의 저장 거부, 독립 OAuth 비활성화, 목록 오류 때 대체 모델을 표시하지 않는 동작을 검증한다.
- `npm run check`, Docker를 포함한 백엔드 71건, 기존 DOM 통합 103건, 모델 프로필 DOM 25건 및 기존 계약 검사를 통과했다. Chrome 데스크톱·모바일에서 최종 호스트의 API 키 입력과 두 OAuth 경로의 비활성화 표시를 확인했다. 두 로그인 RPC 모두 호스트에서 `UNSUPPORTED_AUTH`로 거부됐다. 로컬 증거는 `~/.athena/evidence/m31-browser-5NwZFs/`에 있다.
- 이전 버전에 저장된 등록을 가정해 임시 암호화 보관소에 테스트 자격 증명을 넣고 실제 Athena 호스트를 열었다. 모델 새로고침은 빈 계정 목록을 반환했고, 해당 등록을 참조한 프로필 저장은 `AUTH_REQUIRED`로 거부됐다. 응답에 토큰이 노출되지 않았고 기존 보관소 값도 바뀌지 않았다.

## Pending · 공개 요건과 실계정 인수

현재 저장소는 비공개이며 GitHub에 등록된 라이선스가 없다. 프로젝트 소유자는 이 배포에 적용되는 OpenAI 승인이나 자격이 확인된 공개 배포가 아직 없다고 확인했다. 현재 보관소는 활성 OpenAI 자격 증명 하나를 관리한다. 공식 지침의 다중 등록 보관·계정 선택 및 원격 재발급 세션 철회도 남아 있다. 이 배포에서는 이전에 저장된 OAuth 자격 증명이나 환경 설정으로 이 제한을 해제할 수 없다.

공식 배포 자격을 확보하고 계정 관리 요건을 충족하면 아래 항목부터 재개한다. 이번 납품에서 실제 ChatGPT 계정을 사용하지 않았으므로 7개 모두 Pending이다.

| 실계정 인수 항목 | 상태 |
|---|---|
| 실제 ChatGPT 로그인 가능 여부 확인 | Pending |
| OAuth 권한과 계정 상태 검증 | Pending |
| 사용자 모델 카탈로그 실제 조회 검증 | Pending |
| 접근 가능한 Codex 계열 모델 확인 | Pending |
| 채팅에서 계정 모델을 선택해 검증 | Pending |
| 실제 Pi 스트리밍 요청 수행 검증 | Pending |
| 지원 도구 호출을 통해 실행 검증 | Pending |

공식 문서: [OpenAI 시작 안내 및 승인](https://developers.openai.com/siwc/quickstart), [로그인](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), [계정 모델과 추론](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference), [Preview 제한](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations), [계정 및 세션 관리](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions).
