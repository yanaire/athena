# Athena M1 인수 기록 · 2026-11-20

구현 커밋: `e3bcd87`. 첨부 원본 기준선: `ffc8643`. 백엔드 TypeScript 검사 통과, `npm test` 13/13 통과. 브라우저와 실모델 증거는 아래에 별도로 기재했다.

범위는 [START-HERE의 첫 납품](../athena-backend-handoff/START-HERE.md)이다. 아래의 실모델 검사는 로컬 llama.cpp **b12556 (`50518b64c`)**, `unsloth/Qwen3-1.7B-GGUF/Qwen3-1.7B-Q4_K_M.gguf`, 공식 Pi **1.5.2**, Node **24.22.3**, macOS **27.2 arm64**에서 수행했다. HTTP 모델 응답이나 도구 이벤트를 테스트 코드로 생성하지 않았다. Chrome 157은 별도의 새 프로필로 열었다.

## 실제 읽기 → 답변 → 재시작

```sh
# 모델 실행기와 GGUF를 내려받은 디렉터리에서
./llama-b12556/llama-server -m ./Qwen3-1.7B-Q4_K_M.gguf \
  --host 127.0.0.1 --port 62279 --alias m1-qwen3-1.7b --jinja \
  --chat-template-kwargs '{"enable_thinking":false}' -c 8192 -ngl 99
# Athena 저장소에서 (별도 터미널)
ATHENA_ENDPOINT=http://127.0.0.1:62279/v1 ATHENA_MODEL=m1-qwen3-1.7b \
  node scripts/live-acceptance.mjs
```

| 관측 | 값 |
|---|---|
| 프로젝트 / 메인 Pi 대화 | `548c4bee-07e1-433f-a94d-3e0754dcfddc` / `01a1f6da-1a7b-7130-9d1c-22c29a9eba64` |
| run / task | `d3172d97-1f8f-42ac-953f-b91ecaf8ba71` / `1a823cfe-baec-4a16-93b4-f89f764a4b8a` |
| tool / staged ref | `tool-0d7b5f96bed55dc2536cb023a5c2432d` / `fd8b81c4-e104-47b2-91e3-a5dfb3f3fcfd` |
| 원본 `calibration.txt` SHA-256 | `09c1b13c1806c237f5d4c452eaa5dc6de6e79bce251181c3137e931cd4cf7784` |
| 모델이 보낸 최종 응답 | `The calibration serial number is: ATH-18d86b35b3.` |
| 실제 스트림 / 완료 | `text_delta` 19개 / `read` succeeded / run succeeded |
| 재시작 전후 `get_messages` | 5개 / 5개. 양쪽 JSON의 SHA-256이 모두 `b3265718b00191dec061be58f13e4826f3a0b487d272f25d9a5d5c2a14c475be` |

모델 입력에는 파일 경로를 넣었다. 식별자와 파일 본문은 `read` 결과로 전달됐다. 스크립트가 같은 데이터 디렉터리에 새 Node 프로세스를 띄워 프로젝트·run·tool 및 설정 ID가 유지되는지, 연결 확인은 `not_checked`로 돌아가는지 검사했다. 대화를 다시 열어도 같은 메시지였다. 명시적 파일 업로드는 연구 Knowledge 자료 저장·색인과 별개다.

## 검사 범위

[재시작한 실제 호스트의 화면](../athena-backend-handoff/athena-codex-ui/qa/hosted-evidence/real-host-restart.png)에서 위 답변과 `File read · Complete`, 같은 session/run ID를 확인했다. 별도의 Chrome 대화 `Bench notes / Calibration review`에서도 업로드한 `bench-reading.txt`를 읽고 `The calibration serial number is BENCH-581D.`를 받았다. 지원하지 않는 `voltage.bin`은 전송 전에 거부됐고 원문 초안과 첨부가 입력창에 남았다.

프런트엔드 회귀 검사: DOM 통합 **102/102**, 계약 검사 **52/52**. [브라우저 QA 기록 및 화면 목록](../athena-backend-handoff/athena-codex-ui/qa/hosted-evidence/report.json)에서 데스크톱·모바일 fixture와 실모델 대화 화면을 구분한다.

| 인수 항목 | 결과 및 경계 |
|---|---|
| A02/A03/A06 | 고정된 실모델 서버에서 모델 목록 확인, 설정 저장, 재기동 확인 **PASS**. 인증 거부와 다른 주소로 키 전송 차단은 로컬 HTTP fixture에서 확인. 인증 유료 공급자는 실검증하지 않았다. |
| A01/A04/A05 | 기존 폼 형식 검사, 프로젝트 모델 설정, 실행 당시의 모델 기록, 단일 모델 선택 범위. 서로 다른 네 모델 교체 시나리오는 단일 모델 호스트에서 **NOT RUN**. |
| B01/B02/B04/B08/B09 | 프로젝트 생성 → 새 대화, 세션별 프록시와 실제 파일 전송 **PASS**. 잘못된 세션/변경된 참조는 통합 테스트에서 거부. 브라우저에서 바이너리 첨부가 거부된 뒤 같은 파일과 초안 유지 확인. |
| B03/B05/B06/B07 | 기존 UI fixture 및 요청 ID 중복 방지 회귀 검사. 모든 경합·ACK 유실 시나리오를 실브라우저에서 주입하지 않았다. 불확실한 전송을 새 제출로 반복하기 전 대화·실행 기록을 확인해야 한다. |
| C01/C03/C04/C05/C06 | 빈 스냅샷, 동일 scope의 루트 작업·파일 읽기, 실제 Pi 이벤트와 스트리밍 **PASS**. 완료 중복·역순·중단은 별도 fixture/SDK 통합 검사. 자식 작업·자동 재시도는 이 판정에 포함하지 않는다. |
| D01/D09 | 실제 호스트 종료 → 재기동, 대화·실행 재조회 **PASS**. 실행 중 SIGKILL 복구는 별도 subprocess 검사: 중복 실행하지 않고 중단 상태로 남긴다. |
| C02/C07–09, D02–08/D10 | 확장 대화상자, 자식/승인/시도, Knowledge 원격 복원·추출, 문서 버전·근거·검토, PDF, 전체 출력 탐색 서비스는 **미납품**. G2–G5는 해당 서비스를 만들기 전 해결할 항목이다. |
| E01–E04 | 첫 납품 화면만 직접 점검. 전체 접근성, 스크린 리더, 가상 키보드, 모든 줌·모션 조합은 **NOT RUN**. |

기존 HTML/DOM fixture는 실제 모델을 사용하지 않는다. `npm test`의 SDK 통합 검사도 통제된 제공자 응답을 사용한다. 실제 생성과 재시작 판정은 위 라이브 스크립트의 결과다. 서버는 단일 사용자·한 번에 하나의 메인 실행을 지원한다. 데스크톱 패키징, 워커·공학 도구·독립 검토를 포함한 후속 연구 E2E는 완료 범위가 아니다.
