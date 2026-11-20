# M2 인수 기록 · 2026-11-20

기준은 M1 `9c4db64b5e08eb6f0995868181cb46abb63a593d`다. 기존 UI에서 프로젝트와 대화를 만들고 `measurements.csv`를 첨부해 전송했다. 부모의 실제 Pi 이력에 `spawn_agent` 두 건과 `wait_for_agents`가 남았다. 아래 기록은 이 브라우저 요청 한 건에서 나온 결과다.

| 실제 실행 | 관측 결과 |
|---|---|
| 모델 / run | 로컬 Qwen3-1.7B, `m1-qwen3-1.7b` / `da11128e-cc09-4e9c-937e-461154ace2fd` |
| 부모 | Pi `01a1f704-a8a5-71f9-b988-83e71dc290e1`, attempt `18fdf4bb-574d-4345-a062-47135b47a4d0`, 메시지 19개 |
| 파일 감사 자식 | Pi `01a1f704-afe3-71f9-b988-83e833512848`, attempt `7cc73460-0274-499d-a8d8-42736438ed15`, 메시지 7개. `read` 사용. 이 자식도 스스로 계산을 한 번 요청했다. |
| 통계 자식 | Pi `01a1f704-afed-71f9-b988-83ea7eb5ee85`, attempt `c6c4e009-33ac-4549-bc2a-9d88a8810f34`, 메시지 5개. `calculate_csv`가 OS 프로세스 `8e6bbcf9-c390-44de-9743-94d8f9b80b73`(PID 17043, exit 0)를 생성했다. |
| 두 모델 응답의 중첩 | SQLite `pi_event`의 자식별 assistant `message_update` 델타 시각을 대조했다. 한 스트림의 한 응답은 `1795145643565–1795145644391` ms에, 다른 스트림의 한 응답은 `1795145643985–1795145645175` ms에 델타를 내어 **406 ms** 겹쳤다. GPU 커널의 동시 실행 여부는 측정하지 않았다. |
| 독립 검산 | 데이터 5행. `C`가 비어 있고 단위는 mV다. `(7+13+21+35)/4=19`, 최소 7, 최대 35. 부모 최종 답변과 다운로드한 `statistics.json`의 값이 일치했다. |
| 결과 파일 | 두 자식의 별도 파일은 각각 178바이트, SHA-256 `14d3d2b9b85d09f79c9c8802660cebcd86aeb3fff63f2466b272dac225a081a3`. 통계 자식의 파일 ID `da08196b-8bb0-49c4-8425-3f633cd4818c`. 부모는 같은 내용인 감사 자식의 파일 `033648ad-6407-4012-8128-6d5ce95f5d4c`의 실제 URI를 답했다. |
| 재시작 | 같은 데이터 경로에서 호스트 프로세스를 교체하고 읽기 전용 검사기의 JSON 출력을 `cmp`로 대조했다(종료 0). 두 자식과 부모의 메시지, task·attempt·tool·process ID, stdout/stderr, 파일 메타데이터와 다운로드 결과가 같았다. 실행 기록 지문 `03746ac8e9dfa814219207edb1ee8532525ea3fddbeb5dc4b327ef56d9f62dce`. |

**실패도 관측했다.** 앞선 실모델 실행 한 번은 평균은 맞혔지만 입력 파일을 결과 파일이라고 답했고, 한 번은 자식이 성공하고도 부모가 원본 파일을 잘못된 경로에서 다시 읽어 답변에 실패했다. `succeeded`는 Pi 실행의 종료 상태이지 답변의 정확도 보장이 아니다. 완료된 자식 결과를 바로 요약하도록 지침을 수정하고, 매니저가 검증한 결과 URI를 자식·부모 및 UI에 전달했다. 위 표는 수정 후 성공한 실행 한 건이다. 모든 프롬프트에 대한 모델 성공률은 측정하지 않았다.

**재현 방법.** [README의 설치 절차](../README.md)로 도구 호출 가능한 모델과 호스트를 시작한다. 새 대화에 [입력 CSV](measurements.csv)를 올리고 두 자식을 요청한다. 부모가 합류한 후 다음을 실행한다. 비교하는 동안 새 작업을 시작하거나 다른 대화를 선택하지 않는다.

```sh
node scripts/inspect-m2.mjs http://127.0.0.1:4317 > before.json
# 호스트를 종료하고 같은 ATHENA_DATA_DIR 및 모델 환경에서 npm start
node scripts/inspect-m2.mjs http://127.0.0.1:4317 > after.json
cmp before.json after.json
```

검사기는 작업을 생성하지 않는다. 실제 모델이 생성한 각 도구 호출과 결과를 시도별 Tool 레코드와 연결하고, 다운로드 바이트를 해시 및 알려진 참값과 대조한다. 공개 화면 자료가 아닌 SQLite, Pi JSONL, 첨부 원본, 로컬 실행 경로 및 원시 로그는 `~/.athena/evidence/m2-orchestration/`에 남겼다. `verification-cFLXVS/`에 Workflow·타임라인·Artifacts 화면, 재시작 전후 검사 출력이 있다.

**통제된 회귀 검사.** `npm run check`, `npm test`를 루트에서 실행한다. `tests/manager-orchestration.test.ts`와 `tests/manager-limits.test.ts`는 공식 Pi SDK와 통제된 HTTP 제공자를 사용한다. 1슬롯 대기 중 슬롯 양보, 2슬롯 동시 모델 요청, 위임·추가 지시 중복/충돌, 대화 전환·자식 취소, 실패 전달, 전체 취소와 실제 프로세스 그룹 종료, SIGKILL 후 중단 기록 복구와 재실행 금지를 검사한다. 세부 파일 격리·한도는 [프로세스 명세](M2-PROCESSES.md)에 있다. UI 회귀 명령은 다음과 같다. Bun은 브라우저 검사에서만 사용한다.

```sh
cd athena-backend-handoff/athena-codex-ui
python3 build.py
(cd qa && npm ci && npm test && node --test pi-host-adapter-test.mjs runtime-integrity-test.cjs workspace-session-test.cjs connection-manager-test.cjs research-records-test.cjs workspace-views-test.cjs)
ATHENA_BROWSER_WIDTH=1440 bun qa/m2-browser-test.js
ATHENA_BROWSER_WIDTH=390 bun qa/m2-browser-test.js
```

**범위.** 호스트는 단일 사용자·단일 writer, macOS/Linux, 독립 Pi 세션의 직속 자식까지만 지원한다. 자식은 허용된 입력 버전만 읽고, 고정 CSV 명령만 실행한다. 임의 셸, 다단계 위임, 자동 재시도, 재시작 후 과거 PID 재접속·종료는 지원하지 않는다. 복구 시 확인할 수 없는 종료는 성공으로 바꾸지 않는다. 보관본 이동에 관한 M1 제한과 동결 커밋의 별도 회귀 판정은 [M1 마감 기록](m1-closure/m1-closure-manual-qa.md)에 있다.

M2 후보에서 타입 검사와 백엔드 33/33, 기존 UI DOM 102/102 및 계약 52/52가 통과했다. `scripts/live-acceptance.mjs`로 M1 경로도 별도 실행했다. Qwen이 첨부에서 `ATH-c58c81b091`를 읽어 18개 델타로 답했고, 메시지 5개의 SHA-256은 재시작 전후 `b8df3b1b9fa40f17253a70fed4867f7049cb4a3321aced5bc7fbb8c6b40f4fd6`였다.

공개 이력은 원시 Pi JSONL을 수정하지 않고, 저장된 시도에 대응하는 메시지에서 `toolCall.id`와 `toolResult.toolCallId`를 동일한 Athena ID로 투영한다. `rawToolCallId`에는 SDK 식별자가 남는다. 위 실행을 재시작한 뒤 이 공개 이력의 SHA-256은 부모 `106964905cdeda108a858fcdc8876b318c4ca28216c97ab683f4110c1c77c3d6`, 감사 자식 `9c17cf01c5da5c8ce135946e1498f764c4806aff7944fd951684cd0591ece451`, 통계 자식 `6a54d84aab2afaa0babd2b129358854c647338b1aa3e4e446da448fffcbfb903`이었다. 대응하는 저널이 없는 M1 이력은 기존 ID를 유지한다.

UI 커밋 `ce2b65a`에서 같은 데이터를 다시 열어 호스트 PID와 종료 코드를 별도로 기록했다. 첫 Node 호스트(PID 38669)를 종료 코드 0으로 내린 뒤 두 번째 호스트(PID 38683)를 시작했다. epoch가 달랐고 두 번의 전체 검사 출력 SHA-256은 `a386f84e3bdc2d323538357425a21d7e2338d95c55c6d8f1f12c3f0872a0aaba`로 같았다. 두 번째 호스트도 종료 코드 0이었다. 원본은 `verification-cFLXVS/host-pid-restart.log`와 `verified-{before,after}.json`이다.

390px 브라우저 검사에서는 재연결 알림이 전체 취소 버튼의 클릭을 가로채는 결함이 발견됐다. 안내문은 보이되 클릭을 받지 않도록 수정한 뒤 알림을 띄운 상태로 390px·1440px에서 버튼 중앙의 클릭 대상과 취소 상태 전환을 확인했다. 화면 증거는 `~/.athena/evidence/m2-cancel-run-ZbeuXZ/`에 있다.
