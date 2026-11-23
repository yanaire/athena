<img src="assets/icon.svg" width="64" height="64" alt="">

# Athena · local research workspace

Athena의 로컬 Node 호스트는 기존 UI, 자체 TaskManager, 공식 Pi SDK로 실행됩니다. M2에서는 메인 모델이 독립 세션의 자식에게 파일 확인과 CSV 계산을 위임하고 그 결과를 합쳐 답합니다. OmO 설치·로그인·세션은 필요하지 않습니다. `athena-preview.html`을 파일로 직접 열면 독립 데모이므로 실제 작업은 아래 HTTP 주소에서 시작하세요.

**M4.2 오프라인 분석** — Docker 없이 Wasmtime에서 CPython과 QuickJS-ng를 실행합니다. 프로젝트마다 기본으로 꺼져 있으며 **Settings → Agents & execution**에서 켭니다. Python은 WASI 표준 라이브러리를 사용합니다. JavaScript의 기존 `language: "node"` 값은 QuickJS를 뜻하며 Node 내장 API와 npm은 지원하지 않습니다. `read`와 `calculate_csv`는 분석 실행기를 준비하지 않아도 쓸 수 있습니다. [실행기 범위](docs/sandbox-security.md)를 참고하세요.

**ChatGPT 플랜 모델** — 기본 배포에서 ChatGPT 로그인은 비활성화되어 있습니다. 개인용 로컬 macOS 빌드에서는 공식 Sign in with ChatGPT를 사용할 수 있습니다. 계정과 워크스페이스 자격은 OpenAI가 판단합니다. [로컬 빌드와 연결 방법](docs/installation.md#personal-local-build-with-chatgpt) · [검증 기록](docs/m42/siwc.md).

**macOS 소스 빌드** — Apple Silicon과 macOS 13.5 이상에서 개발 도구를 설치하고 [소스 빌드 안내](docs/installation.md)를 따릅니다. 생성되는 로컬 `Athena.app`에는 Node.js, Pi SDK와 두 분석 인터프리터가 포함되지만 모델 가중치와 자격 증명은 포함되지 않습니다. 정식 서명·공증된 앱이나 공개 다운로드는 이번 Preview에 없습니다. [모델 설정](docs/model-providers.md) · [데이터 보관](PRIVACY.md) · [개발](docs/development.md) · [배포 전 확인](docs/release-checklist.md).

**M4.4 인증 보관** — 앱은 시작할 때 `~/Library/Application Support/Athena/auth/credentials.v2.json`을 자동으로 준비합니다. 인증 파일은 평문이며, 디렉터리 `0700`과 파일 `0600`은 다른 OS 사용자 접근을 제한합니다. 같은 macOS 사용자 권한으로 실행되는 프로그램과 권한 있는 관리자, 백업으로부터 이 파일을 보호하지는 않습니다. 기본 실행은 Keychain을 요청하지 않습니다. 기존 보관소를 가져오려면 앱의 **Settings → Models → Approve import from Keychain**을 선택합니다. 가져오지 않아도 기존 보관소와 프로젝트는 유지되며, 제공자를 다시 연결할 수 있습니다. [저장 및 마이그레이션](docs/keychain-security.md).

Athena 자체 코드의 선택된 라이선스는 [Apache-2.0](LICENSE)입니다. 기존 UI, 아트워크 및 제3자 코드의 권리와 고지는 [별도 검토](THIRD_PARTY_NOTICES.md) 중이며, 이 선택만으로 그 자료의 재배포 권한이 확인되는 것은 아닙니다. 공개 승인 전까지 이 후보를 외부에 배포하지 마세요. [알려진 제한](docs/known-limitations.md) · [Keychain 보안](docs/keychain-security.md).

[M4.2 로컬 납품 기록](docs/m42/release-notes.md)에서 최종 ZIP 체크섬, 실제 Qwen 실행 결과와 공개·인증 보류 항목을 확인할 수 있습니다.

**브라우저 호스트 실행** — Node.js 24.22.3에서 검증합니다. 먼저 도구 호출과 OpenAI 호환 스트리밍을 지원하는 모델 서버를 실행하세요. 모델 가중치 및 자격 증명은 저장소에 포함하지 않습니다.

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

**M2 실행 예시** — 새 대화에 [`docs/measurements.csv`](docs/measurements.csv)를 첨부하세요. “두 작업을 위임해 줘. 첫 자식은 `read`로 행 수, 결측값, 단위를 확인하고 둘째는 `calculate_csv`로 `measurement_mV` 통계를 `statistics.json`에 만들어. 두 자식을 모두 시작한 뒤 결과를 기다렸다가 평균과 실제 결과 파일 링크를 알려 줘.”라고 보내세요. Workflow에서 세 작업을 확인하고 Artifacts에서 **Download result file**을 누르면 됩니다. [실모델 인수·재현 기록](docs/M2-ACCEPTANCE.md)과 [프로세스 제한](docs/M2-PROCESSES.md)을 참고하세요.

| 환경 변수 | 기본값 | 허용 범위 / 의미 |
|---|---:|---|
| `ATHENA_MODEL_CONCURRENCY` | 2 | 1–64. 부모가 대기할 때 슬롯을 자식에게 양보합니다. |
| `ATHENA_PROCESS_CONCURRENCY` | 1 | 1–4. CSV 프로세스는 모델과 별도 한도를 사용합니다. |
| `ATHENA_MAX_CHILDREN` | 8 | 0–128. 부모가 한 실행에서 만들 수 있는 직속 자식 수입니다. |
| `ATHENA_MAX_DEPTH` | 1 | 0이면 위임을 끄고, 1이면 직속 자식까지만 허용합니다. |

**구조와 경계**

| 기존 UI 동작 | 실제 소유자 / 통신 | 보관·확인 대상 |
|---|---|---|
| Models 형식 검사 / 연결 확인 / 저장 | 기존 폼 / `Connections.verifyConnection` / `saveConfig` | 형식 검사는 로컬. 확인은 고정된 주소의 `GET /models`, 저장은 `connections.sqlite`. 키는 브라우저로 보내지 않음 |
| Add project / New research / 대화 열기 | `TaskManager` → SQLite 및 Pi `SessionManager` | 프로젝트 ID, 제목, 대화 ID, 활성 범위. 대화 ID는 실제 메인 Pi 세션 ID |
| 첨부 및 파일 읽기 | 브라우저 → `stageFiles` → 프로젝트 파일 / Pi의 `read` | 파일 이름만 전달하지 않고 바이트를 저장. 모델은 도구 결과로 내용을 읽음. 셸·쓰기·네트워크 도구 없음 |
| 전송 / 실시간 답변 | 기존 composer → 세션별 프록시 → TaskManager → 공식 Pi SDK 1.5.2 | 수락 ID, 실제 이벤트, 모델·run·task·tool ID. SSE를 통해 채팅과 작업 화면으로 전달 |
| 대화와 실행 다시 열기 | `/api/bootstrap`, `get_messages`, TaskManager snapshot | SQLite의 실행 기록과 세션 JSONL의 메시지를 읽음. 브라우저 저장소는 실행의 정본이 아님 |
| Workflow / Agents / Execution | 같은 TaskManager snapshot, 독립 Pi 이력 | 작업 관계와 시도, 메일함, 모델이 호출한 도구, 프로세스의 명령·출력·종료 상태 및 취소 |
| Artifacts | 생성 시도 및 입력 버전과 연결된 CSV 계산 결과 또는 분석 소스·CSV·JSON·텍스트 | 호스트가 소유권과 바이트 해시를 확인한 후 내려보냅니다. 모델 답변에 적힌 경로는 정본이 아닙니다. |
| Knowledge / Manuscript / 고급 Pi 기능 | 기존 화면과 capability 경계 | 영속 연구자료 서비스, 버전 PDF, 리뷰, 플러그인, 승인·자동 재시도는 구현하지 않았습니다. |

호스트는 `127.0.0.1`에서만 듣고 요청의 Host·Origin·Content-Type을 제한합니다. `ATHENA_ENDPOINT`와 모델은 운영자가 고정합니다. 브라우저에서 다른 주소로 같은 키를 보내거나 실행 도중 모델을 교체할 수 없습니다. 모델 목록 검증 성공은 생성·도구 호출 검증과 구분합니다. `GET /api/bootstrap`, `POST /api/rpc`, `GET /api/events`의 브라우저 계약은 [`host-wire.d.ts`](athena-backend-handoff/athena-codex-ui/integrations/host-wire.d.ts)에 있습니다.

**검증**

```sh
npm run check
npm run analysis:prepare
npm test
python3 athena-backend-handoff/athena-codex-ui/build.py
# 위와 동일한 ATHENA_ENDPOINT, ATHENA_MODEL이 필요. 실제 토큰을 사용합니다.
node scripts/live-acceptance.mjs
```

실제 인수 스크립트는 임시 데이터 디렉터리에서 새 프로세스를 띄웁니다. 무작위 식별자를 담은 파일을 업로드하고 실제 `read`와 모델 답변, 텍스트 델타, ID 연결을 검사합니다. 호스트 종료·재기동 후 메시지 SHA-256을 다시 계산합니다. 데이터 경로는 출력되며 사후 점검을 위해 남겨 둡니다. `tests/`의 모의 제공자 회귀 검사는 이 결과를 대신하지 않습니다. 기존 DOM/계약 fixture 검사는 [START-HERE](athena-backend-handoff/START-HERE.md) 참조.

상세 판정과 알려진 제한: [M1 인수 기록](docs/M1-ACCEPTANCE.md). 원 계약과 후속 단계: [ACCEPTANCE](athena-backend-handoff/ACCEPTANCE.md), [CONTRACT-GAPS](athena-backend-handoff/CONTRACT-GAPS.md).
