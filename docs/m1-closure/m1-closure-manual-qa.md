# Athena M1 검증 기록 · 2026-11-20

**판정: 고정 경로에서 M1 실행 및 재시작 PASS. 원본과 바이트가 같은 보관본을 다른 경로에서 직접 복구하는 시나리오는 FAIL.** 소스 `9c4db64b5e08eb6f0995868181cb46abb63a593d`를 detached worktree에서 검증했다. 보관본 재배치 실패를 해결하려면 원래 경로에서 복구하거나, SQLite에 저장한 절대 경로와 Pi 세션 헤더를 함께 옮기는 지원 절차가 필요하다. 제품 코드를 수정하지 않았고 커밋하지 않았다.

취소된 선행 작업이 남긴 detached worktree, 증거 보관본, 재현 스크립트를 확인했다. 매니페스트 73개 항목의 크기와 SHA-256이 보관본에 일치했고, 확인 시점의 원본도 모두 일치했다. SQLite와 관련 WAL/SHM, Pi JSONL, 업로드 원본, 매니페스트, 기존 검토 및 실행 기록은 `~/.athena/evidence/m1-closure-20261120/`에 보관했다. 디렉터리는 `0700`이다. DB를 열거나 호스트를 띄운 대상은 별도 복사본뿐이다. 아래 문서는 원문 대화·파일 내용이나 인증 정보를 싣지 않는다. ULW 계획이 없어 호출자가 지정한 문서 디렉터리를 QA 기록 위치로 사용했다.

이전 게이트 보고에는 계약 검사 집계 51 통과·1 실패 및 요청 ID 테스트 단독 7/7 재실행이 기록되어 있다. 고정 커밋에 포함된 옛 TAP의 51/51과 기존 요약의 52/52도 서로 다른 기록이다. 이번 판정에는 **새로 실행한 단일 집계 52/52, 종료 0**을 사용했다. 실패했던 당시의 원인은 입증하지 못했다. 옛 재시작 화면은 브리지를 교체한 기록이 있으므로 이번 새 호스트의 화면 증거와 구분했다.

새 로컬 모델 실행은 파일 내용에 포함된 새로운 식별자를 실제 `read`로 반환했고 텍스트 델타 16개를 관측했다. 동일 데이터 경로에서 새 Node 프로세스로 재기동해 메시지 5개의 공개 응답 SHA-256이 동일함을 확인했다. 이전 자료의 SQLite/Pi/업로드 대조에서도 성공 상태의 run·task·tool, 도구 호출과 결과의 연결, 실제 업로드 바이트, 메시지 5개 및 저장된 텍스트 델타 19개를 확인했다.

바이트가 같은 복사본에서 호스트는 `Session header does not belong to this project.`로 종료 1을 반환했다. 일회용 두 번째 복사본에서 SQLite의 세션·파일·도구 경로와 Pi JSONL 헤더의 작업 경로만 보정했다. 헤더 다음의 JSONL 바이트는 그대로 유지했다. 이 복사본에서는 새 호스트에서 대화와 `File read · Complete`가 보였고, 실제 호스트 종료 시 `Retry connection`이 표시됐다. 새 프로세스를 띄우고 버튼을 눌러 기존 답변·도구 결과·같은 세션 및 실행 ID를 복구했다. 재연결 직후 화면에 이전 끊김 알림이 잠시 남은 상태도 캡처했다. 사이드바의 대화를 클릭해 다시 열었으며, 390 CSS px 새 모바일 컨텍스트의 문서 너비도 390이었다. 모바일 캡처는 기본으로 열린 탐색 패널이 본문 일부를 가린 상태다. 전체 접근성 판정에는 사용하지 않았다.

## manualQa

`P` = `~/.athena/evidence/m1-closure-20261120`, `W` = detached `../athena-m1-closure-frozen`, `Q` = `W/athena-backend-handoff/athena-codex-ui/qa`. CLI 명령의 전체 인수·실행 디렉터리는 [E03]과 [E04]에 보존했다. 브라우저 실행은 Chrome 157.0.8103.79와 실제 로컬 호스트를 사용했다. 브라우저 자동화 셀렉터 및 첫 경로 보정 스크립트 오류의 원본 로그도 개인 보관소에 남겼다. 해당 오류는 제품 동작 판정에서 제외했다.

### surfaceEvidence

| 시나리오 | 기준 | 표면 | 정확한 호출 및 동작 | 판정 | artifactRefs |
|---|---|---|---|---|---|
| S01 | M1 증거 보존 | 파일·SQLite·Pi JSONL | `python3 - "$P"`로 `manifest.json` 전 항목 SHA-256 대조. 별도 `inspection-copy`를 SQLite `mode=ro`로 열어 `PRAGMA integrity_check`, `records` 및 Pi JSONL·업로드 교차 검증 | PASS | E01, E02 |
| S02 | 고정 커밋 빌드 | CLI, W | `npm ci`; `npm run check` | PASS, 종료 0 | E03, E05 |
| S03 | M1 UI 빌드 | CLI, Q의 상위 디렉터리 | `python3 build.py`; 생성한 `athena-preview.html`의 Git diff 없음 | PASS, 종료 0 | E03, E06 |
| S04 | A/B/C/D 백엔드 회귀 | CLI, W | `npm test` → `node --test tests/*.test.*` | PASS, 13/13, 종료 0; 통제된 HTTP 제공자 | E03, E07 |
| S05 | UI DOM 회귀 | CLI, Q | `npm ci`; `npm test` → `node integration-test.cjs` | PASS, 102/102, 종료 0; LinkeDOM | E03, E08 |
| S06 | UI 계약 집계 | CLI, Q | `node --test pi-host-adapter-test.mjs runtime-integrity-test.cjs workspace-session-test.cjs connection-manager-test.cjs research-records-test.cjs workspace-views-test.cjs` | PASS, 52/52, 종료 0 | E03, E09 |
| S07 | A02/A03/A06, C03/C04, D01 | CLI, W 및 실모델 | `TMPDIR="$P/frozen-live" ATHENA_ENDPOINT=http://127.0.0.1:62279/v1 ATHENA_MODEL=m1-qwen3-1.7b node scripts/live-acceptance.mjs` | PASS, 종료 0; 파일 읽기, 스트림, 동일 경로 재시작 | E10 |
| S08 | D01, 보관본으로 새 호스트 | `node runtime/server.ts`, 바이트가 같은 복사본 | W에서 `ATHENA_DATA_DIR="$P/browser-rerun/workspace" ATHENA_PORT=46317 ATHENA_ENDPOINT=http://127.0.0.1:62279/v1 ATHENA_MODEL=m1-qwen3-1.7b node runtime/server.ts` (`browser-recovery-first.cjs`가 사용한 호출; 실패 기록을 `browser-unmodified/`로 옮김) | FAIL, 종료 1; 절대 경로 불일치로 HTTP 시작 전 종료, 브라우저 접속 불가 | E11 |
| S09 | C04/D01, 재연결·다시 열기 | 실제 Chrome, 1440×900 | `python3 "$P/rebase-copy.py" "$P/browser-rerun/workspace"` 후 `node "$P/browser-recovery.cjs"`; `http://127.0.0.1:46317/` 열기 → SIGTERM → 같은 복사본에 새 PID → Retry connection 클릭 → 사이드바 대화 클릭 | PASS, 종료 0; 경로 보정한 복사본에 한함 | E12, E13, E14, E15 |
| S10 | D01, 좁은 화면 | 실제 Chrome 모바일 컨텍스트 | 같은 `node "$P/browser-recovery.cjs"`에서 390×844, DPR 3으로 새 컨텍스트를 열고 같은 URL을 탐색 | PASS, 저장된 대화 복원 및 가로 문서 너비만 판정 | E12, E16 |
| S11 | A06/D01 | 실제 HTTP | `curl -i -sS --max-time 10 http://127.0.0.1:46317/api/bootstrap` 전후; `curl -i -sS --max-time 10 -H 'Content-Type: application/json' --data '{"method":"pi","args":["01a1f6da-1a7b-7130-9d1c-22c29a9eba64",{"type":"get_messages","id":"m1-closure-read-history"}]}' http://127.0.0.1:46317/api/rpc` | PASS, 세 응답 HTTP 200; 설정 ID 동일, `not_checked`, 기존 공개 이력 해시 일치 | E12, E17 |

### adversarialCases

| 시나리오 | 기준 | 유형 | 기대 동작 | 판정 | artifactRefs |
|---|---|---|---|---|---|
| X01 | D01/보관본 | 데이터 루트 이동 | 보관본 그대로 새 루트에서 기동하여 대화를 복구한다 | FAIL; 원본 프로젝트 절대 경로에 묶인 Pi 헤더 및 DB 경로 | E11 |
| X02 | D01 | 실제 EventSource 중단 | 연결 실패를 표시하고, 새 호스트 기동 후 재시도로 기록을 복구한다 | PASS, 경로 보정한 복사본 | E12, E13, E14 |
| X03 | A02/A06 | 인증 거부·설정 대상 불일치 | 연결 실패를 보고하고 저장·키 전송을 성공 처리하지 않는다 | PASS, 백엔드 로컬 제공자 테스트 | E07 |
| X04 | B04/B08 | 오래된 세션·변조한 파일 참조 | 활성 세션과 다른 요청 또는 변조한 참조를 거부한다 | PASS, 백엔드 테스트 | E07 |
| X05 | C04 | 파일 경계·지원하지 않는 입력 | 읽기 범위를 벗어나거나 지원 한도를 초과하는 입력을 도구가 거부한다 | PASS, 백엔드 파일 테스트; 별도 브라우저 바이너리 첨부 내러티브는 이번 미재현 | E07 |
| X06 | B07/C06/D09 | 요청 중복·호스트 강제 종료 | 중복 요청은 기존 영수증을 재사용하고 중단된 요청을 자동 재전송하지 않는다 | PASS, SDK·서브프로세스 테스트 및 새 런타임 ID 계약 | E07, E09 |
| X07 | C05/C06 | 제공자 오류·취소 | 제공자 오류는 실패로 남고 취소는 SDK 종료 확인 후 확정한다 | PASS, 통제된 HTTP 제공자·SDK | E07 |

실제 디스크 소진 또는 권한 거부에 따른 저장 실패, 브라우저 ACK 유실의 모든 경합, 인증이 필요한 유료 공급자와 전체 접근성은 이번 증거로 판정하지 않는다. M2 작업은 포함하지 않았다.

### artifactRefs

경로는 모두 개인 보관소 `P` 기준이다. 브라우저 PNG, HTTP 응답, 원시 DB 및 JSONL은 공개 문서로 복사하지 않았다.

| ID | 종류 | 설명 | 경로 |
|---|---|---|---|
| E01 | JSON | 원본 보관 manifest와 전 항목 검증 | `manifest.json`, `archive-audit.json` |
| E02 | 로그 | 복사본의 SQLite/Pi/업로드 대조 및 종료 코드 | `legacy-data-inspection.log`, `legacy-data-inspection.exit` |
| E03 | JSON | 새 검사 인수, 작업 경로, 로그 해시, 종료 코드 | `fresh-checks/statuses.json` |
| E04 | 스크립트 | 고정 체크아웃용 검사 실행기 | `reproduce.py` |
| E05 | CLI 로그 | TypeScript 검사 | `fresh-checks/typecheck.log` |
| E06 | CLI 로그 | HTML 빌드 | `fresh-checks/build.log` |
| E07 | CLI 로그 | 백엔드 13개 테스트 | `fresh-checks/backend.log` |
| E08 | CLI 로그·JSON | DOM 102개 검사 및 케이스별 결과 | `fresh-checks/dom.log`, `fresh-checks/dom-results.json` |
| E09 | CLI 로그 | 새 계약 검사 단일 집계 | `fresh-checks/contracts.log` |
| E10 | CLI 로그 | 실모델 읽기·델타·두 이력 해시 및 종료 코드 | `frozen-live/acceptance.log`, `frozen-live/exit-code` |
| E11 | 호스트 로그 | 원본과 바이트가 동일한 복사본의 시작 실패 | `browser-unmodified/host-1.log`, `browser-unmodified/actions.jsonl`, `browser-unmodified/exit-code` |
| E12 | 브라우저 작업 로그·스크립트 | 호스트 PID, 재연결, 세션 재선택, 종료 코드, 경로 보정 | `browser-rerun/actions.jsonl`, `browser-rerun/exit-code`, `browser-rerun/rebase.log`, `rebase-copy.py`, `browser-recovery.cjs` |
| E13 | PNG | 실제 호스트 연결 중단 및 재시도 버튼 | `browser-rerun/desktop-disconnected.png` |
| E14 | PNG | 새 호스트 연결 이후 복구 화면 | `browser-rerun/desktop-after-retry.png` |
| E15 | PNG | 사이드바에서 다시 연 대화 | `browser-rerun/desktop-reopened-session.png` |
| E16 | PNG | 모바일 기본 탐색 패널과 복구된 본문 | `browser-rerun/mobile-fresh-browser.png` |
| E17 | HTTP | `curl -i` 원시 상태·헤더·본문 | `browser-rerun/bootstrap-before.http`, `browser-rerun/bootstrap-after.http`, `browser-rerun/history-after.http` |
| E18 | 기존 검토 | 원래 게이트 검토, 로컬 모델 실행 기록, 기존 브라우저 보고 | `gate-review.md`, `inference/acceptance-evidence.md`, `original-hosted-report/report.json` |
