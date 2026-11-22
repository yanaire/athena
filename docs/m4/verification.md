# M4 인수 기록 · 2026-11-20

## Finder에서 패키징 앱으로 확인한 항목

Apple Silicon Mac에서 ad-hoc 서명된 `Athena.app`을 Finder로 열었다. QA 복사본의 `Info.plist`에만 복제 작업공간과 접속 불가능한 Docker 소켓을 지정하고 다시 서명했다. 번들에는 수정된 Tauri 실행 파일, Node 24.22.3 arm64, Pi 1.5.2가 들어 있었다. 운영용 산출물에는 이 QA 설정이 없다.

| 항목 | 실측 결과 |
|---|---|
| 시작과 기존 UI | 로그인 키체인 암호 입력 없이 기존 연구 화면, 프로젝트와 대화, 설정을 열었다. `Memory only · credentials clear on restart`를 확인했다. SQLite와 JSONL은 이전 M3 인수 자료를 복제했으며 원본 및 기본 `~/.athena/workspace`는 QA에 사용하지 않았다. |
| 기존 기록 | `M3 Local Research`의 기존 대화 3개와 `Settling in Docker`의 완료 결과를 표시했다. 기존 실행 `44507c17-76f5-4c50-8570-199ed65a01f6`의 Artifacts에서 `analysis.py`를 내려받았다. 내려받은 바이트의 SHA-256이 SQLite에 저장된 `2205d2e850164bccea6463fd1d64bdf529ea8f8b9aa1b7322caf58e0f426a9c5` (1,395바이트)와 일치했다. |
| 프로젝트와 대화 생성 | `M4 Finder smoke` (`3089cb1f-166d-473d-accb-f83c01ac366d`)에서 `M4 Pi delegation` (`01a1f845-3302-777b-b128-8fd8a7ba796d`)을 생성했다. 모델 선택기에 기존 1.7B와 4B 프로필이 표시됐으며 새 대화에 `Qwen Analysis 4B`를 선택했다. |
| 실제 Pi와 독립 자식 | 로컬 llama.cpp의 실제 `athena-qwen3-4b-instruct`로 실행 `63b83ae9-fadc-4cc5-967a-37bc4d30b59b`가 성공했다. 부모가 `spawn_agent`와 `wait_for_agents`를 호출했고, 자식 `01a1f846-05e4-777b-b128-8fdba692a8b1`이 별도 JSONL에 `CHILD-43`을 남겼다. 부모의 최종 답변을 앱에서 확인했다. SQLite에서 `text_delta` 153개, `toolcall_delta` 75개를 확인했다. |
| 정상 종료와 재실행 | 앱 `10629` / Node `10635` / 포트 `54187`에서 **Quit Athena**를 실행했다. 09:27:18 UTC에 두 프로세스와 포트가 닫혔고 SQLite `PRAGMA integrity_check`가 `ok`를 반환했다. Finder로 다시 열었을 때 앱 `13005` / Node `13010` / 포트 `54460`이었으며, 기존 대화와 새 답변, `Qwen Analysis 4B` 선택이 복원됐다. |
| 중복 실행과 충돌 | 09:28 UTC에 두 번째 인스턴스를 요청한 뒤에도 `13005`와 `13010`만 동작했다. 유휴 상태에서 QA Node `13010`만 강제 종료하자 네이티브 오류창에 작업공간 복구를 위해 다시 열라는 안내가 나타났다. Finder로 다시 연 앱 `14308` / Node `14313` / 포트 `54533`에서 이전 대화와 응답을 확인했다. 실제 작업 진행 중 강제 종료에 의한 미완료 상태 복원은 백엔드 테스트 결과다. |
| HTTP/SSE 접근 제어 | 다른 로컬 프로세스의 쿠키 없는 HTML, RPC, SSE 요청은 모두 `401`이었다. 정상 Origin을 명시한 쿠키 없는 RPC도 `401`이었다. 앱 안에서는 같은 호스트로 모델 실행과 아티팩트 내려받기가 동작했다. |
| Docker 비가용 | 연결할 수 없는 Docker 소켓을 지정했다. **Agents & execution**이 `docker`와 `Runtime unavailable`을 표시하는 동안 일반 모델, 부모·자식 위임, 기존 아티팩트 조회가 동작했다. Docker 설치를 제거하거나 패키징 앱에서 새 Docker 분석을 실행하지 않았다. |
| M3.1 | Settings에서 `Sign in with ChatGPT · unavailable`과 독립 `OpenAI Codex` 로그인 비가용을 확인했다. [실계정 Pending 7개](../m31/chatgpt-codex.md#pending--공개-요건과-실계정-인수)는 유지했다. |

로컬 증거는 `~/.athena/evidence/m4-finder-eOBHgb/`에 있다. `workspace/workspace.sqlite`에는 위 실행과 스트리밍 이벤트가, `workspace/sessions/`와 `workspace/agents/`에는 독립 Pi 세션이 들어 있다. 원래 M3 인수 기록은 `~/.athena/evidence/m3-chrome-WFQUPG/`에 그대로 있다. 초기 Finder 시도에서 번들 Pi 어댑터 누락, WebKit IPv4 쿠키 확인 오류, 키체인 권한 요청을 발견해 수정했다. 위 결과는 수정 후 앱에서 얻었다.

## 번들 및 개발 환경에서 확인한 항목

- `npm run desktop:build`: `codesign --verify --deep --strict`와 번들 Node 버전·아키텍처, 새 임시 작업공간의 인증된 부트스트랩과 종료가 통과했다. 이 스모크는 Finder 검사와 별개다.
- `npm run check`, 백엔드 77개, UI DOM 103개, 추가 UI/SDK 계약 52개, 모델 프로필 DOM 25개가 통과했다. 메모리 모드를 최종 수정한 뒤 데스크톱 호스트 테스트 6개를 다시 통과했다. 도구 실행·취소, 미완료 복원, 기존 Docker 분석의 회귀 범위는 이 테스트 결과다.
- 인증 회귀는 다른 Origin·Host 거부, 유효한 세션의 RPC/SSE, 대화 범위 결과 파일, 메모리 전용 모드, 잘못된 키 또는 키 없음으로 인한 기존 보관소 열기 거절을 확인했다. 암호화 보관소는 잘못된 키로 시작해도 바이트가 바뀌지 않았다.

## 공개 배포 준비와 미검증 항목

이 Mac에는 Developer ID 서명에 쓸 인증서가 없었다. 로컬 ad-hoc 무결성 검사만 통과했으며 Developer ID 서명, 공증, 다른 Mac에서의 Gatekeeper 통과는 Pending이다. 네이티브 로그인 키체인에 새 키를 쓰고 다시 읽는 경로는 사용자 승인 없이 실행하지 않았다. 실제 앱에서는 암호창 없이 열리는 메모리 모드를 확인했고, 암호화 보관소 보호는 격리된 개발 테스트로 확인했다. 실제 제공자 API 키와 M3.1 실계정 테스트는 수행하지 않았다.

번들에 설치된 운영 npm 패키지 123개의 선언 라이선스는 MIT 60, Apache-2.0 38, BSD-3-Clause 13, ISC 6, BlueOak-1.0.0 4, Unlicense 1, 0BSD 1이었다. Node 배포본 라이선스는 번들에 포함했고, 운영 npm 패키지의 upstream 고지 파일을 설치본에서 제거하지 않았다. Rust 의존성의 전체 고지 목록과 최종 외부 배포 권한 검토는 배포 전에 남아 있다. 모델 가중치, 계정 자격 증명, 기존 작업공간, Docker 이미지는 앱에 포함하지 않았다. Docker 교체 지점과 검증 조건은 [M4.1 설계](docker-free.md)에 기록했다.
