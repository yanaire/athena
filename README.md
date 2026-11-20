<img src="assets/icon.svg" width="64" height="64" alt="">

# Athena · local research workspace

첨부된 Athena UI를 그대로 빌드해 로컬 Node 호스트에서 제공합니다. 첫 납품 단위는 **한 모델, 프로젝트와 대화, 읽기 도구, 실시간 답변 및 재시작 후 조회**입니다. `athena-preview.html`을 파일로 직접 열면 원래의 독립 데모입니다. 실제 작업은 아래 HTTP 주소에서 시작하세요.

**실행** — Node.js 24.22.3에서 검증합니다. 먼저 도구 호출과 OpenAI 호환 스트리밍을 지원하는 모델 서버를 실행하세요. 모델 가중치 및 자격 증명은 저장소에 포함하지 않습니다.

```sh
npm ci
# 예: 로컬 llama-server에서 --alias athena-local로 제공하는 경우
export ATHENA_ENDPOINT=http://127.0.0.1:8080/v1
export ATHENA_MODEL=athena-local
# 인증이 필요한 서버라면 ATHENA_API_KEY를 호스트 환경에만 설정
npm start
```

`http://127.0.0.1:4317` → **Settings → Models**에서 호스트가 지정한 모델을 확인 → **Verify connection**, **Save settings** → 사이드바의 **Add project** → **New research**. 대화에 작은 UTF-8 텍스트 파일을 첨부하고 그 내용을 `read`로 확인하도록 요청하세요. 프로젝트를 생성한 것과 대화를 생성한 것은 별도 동작입니다. 설정 저장도 연결 확인이나 모델 실행을 뜻하지 않습니다.

`ATHENA_DATA_DIR`의 기본값은 `~/.athena/workspace`입니다. 같은 디렉터리와 모델 설정으로 다시 실행하면 저장된 대화와 최근 실행을 읽습니다. 포트는 `ATHENA_PORT`로 변경할 수 있습니다. 단일 사용자가 자기 컴퓨터에서 사용하는 호스트입니다. 외부 인터페이스나 공유 프록시에 노출하지 마세요. 로컬 OS 사용자는 데이터 디렉터리의 평문 대화와 원본 파일을 읽을 수 있습니다.

**구조와 경계**

| 기존 UI 동작 | 실제 소유자 / 통신 | 보관·확인 대상 |
|---|---|---|
| Models 형식 검사 / 연결 확인 / 저장 | 기존 폼 / `Connections.verifyConnection` / `saveConfig` | 형식 검사는 로컬. 확인은 고정된 주소의 `GET /models`, 저장은 `connections.sqlite`. 키는 브라우저로 보내지 않음 |
| Add project / New research / 대화 열기 | `TaskManager` → SQLite 및 Pi `SessionManager` | 프로젝트 ID, 제목, 대화 ID, 활성 범위. 대화 ID는 실제 메인 Pi 세션 ID |
| 첨부 및 파일 읽기 | 브라우저 → `stageFiles` → 프로젝트 파일 / Pi의 `read` | 파일 이름만 전달하지 않고 바이트를 저장. 모델은 도구 결과로 내용을 읽음. 셸·쓰기·네트워크 도구 없음 |
| 전송 / 실시간 답변 | 기존 composer → 세션별 프록시 → TaskManager → 공식 Pi SDK 1.5.2 | 수락 ID, 실제 이벤트, 모델·run·task·tool ID. SSE를 통해 채팅과 작업 화면으로 전달 |
| 대화와 실행 다시 열기 | `/api/bootstrap`, `get_messages`, TaskManager snapshot | SQLite의 실행 기록과 세션 JSONL의 메시지를 읽음. 브라우저 저장소는 실행의 정본이 아님 |
| Workflow / Agents / Execution | 같은 TaskManager snapshot | 메인 작업과 실제 파일 도구를 투영. 자식 에이전트나 계산 결과물을 자동 생성하지 않음 |
| Knowledge / Artifacts / Manuscript / 고급 Pi 기능 | 기존 화면과 capability 경계 | M1에 영속 연구자료 서비스, 버전 PDF, 리뷰, 플러그인, 승인·재시도·워커 스케줄러는 없음 |

호스트는 `127.0.0.1`에서만 듣고 요청의 Host·Origin·Content-Type을 제한합니다. `ATHENA_ENDPOINT`와 모델은 운영자가 고정합니다. 브라우저에서 다른 주소로 같은 키를 보내거나 실행 도중 모델을 교체할 수 없습니다. 모델 목록 검증 성공은 생성·도구 호출 검증과 구분합니다. `GET /api/bootstrap`, `POST /api/rpc`, `GET /api/events`의 브라우저 계약은 [`host-wire.d.ts`](athena-backend-handoff/athena-codex-ui/integrations/host-wire.d.ts)에 있습니다.

**검증**

```sh
npm run check
npm test
python3 athena-backend-handoff/athena-codex-ui/build.py
# 위와 동일한 ATHENA_ENDPOINT, ATHENA_MODEL이 필요. 실제 토큰을 사용합니다.
node scripts/live-acceptance.mjs
```

실제 인수 스크립트는 임시 데이터 디렉터리에서 새 프로세스를 띄웁니다. 무작위 식별자를 담은 파일을 업로드하고 실제 `read`와 모델 답변, 텍스트 델타, ID 연결을 검사합니다. 호스트 종료·재기동 후 메시지 SHA-256을 다시 계산합니다. 데이터 경로는 출력되며 사후 점검을 위해 남겨 둡니다. `tests/`의 모의 제공자 회귀 검사는 이 결과를 대신하지 않습니다. 기존 DOM/계약 fixture 검사는 [START-HERE](athena-backend-handoff/START-HERE.md) 참조.

상세 판정과 알려진 제한: [M1 인수 기록](docs/M1-ACCEPTANCE.md). 원 계약과 후속 단계: [ACCEPTANCE](athena-backend-handoff/ACCEPTANCE.md), [CONTRACT-GAPS](athena-backend-handoff/CONTRACT-GAPS.md).
