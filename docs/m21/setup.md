# 분석 실행 프로젝트 열기

Athena 호스트에는 Node.js 24 이상과 도구 호출·스트리밍을 지원하는 모델 서버가 필요하다. `calculate_csv`만 쓰는 기존 프로젝트는 Docker 없이 열 수 있다. 자식이 직접 작성한 프로그램을 실행할 프로젝트에는 로컬 Docker 엔진과 분석 이미지도 필요하다. Python은 호스트의 `PATH`에서 선택하지 않는다. 모델의 코드를 실행하는 환경은 이미지 내부이며, 호스트 운영자가 이미지 ID와 프로젝트 ID를 고정한다.

1. 저장소 루트에서 `npm ci`를 실행한다. 기존 실행 방법대로 `ATHENA_ENDPOINT`, `ATHENA_MODEL`, 필요한 경우 `ATHENA_API_KEY`를 설정하고 `npm start`로 UI를 연다.
2. Settings에서 모델 연결을 확인하고 저장한다. **Add project**에서 분석 프로젝트를 만든다. 프로젝트 UUID는 같은 호스트의 `GET /api/bootstrap` 응답 `snapshot.projects`에서 이름과 함께 확인할 수 있다. 다른 프로젝트의 권한까지 열 필요는 없다.
3. 아래 명령으로 이미지를 빌드하고 방금 생성한 프로젝트 UUID를 설정한다. 처음 이미지를 빌드할 때는 배포 패키지를 받을 네트워크가 필요하다. 모델이 작성한 코드의 실행에는 네트워크가 필요하지 않다.

   ```sh
   docker build -t athena-analysis:local container/analysis
   export ATHENA_ANALYSIS_IMAGE="$(docker image inspect --format '{{.Id}}' athena-analysis:local)"
   # PROJECT_ID에는 화면에서 생성한 프로젝트의 실제 UUID를 넣는다.
   export ATHENA_EXECUTION_PROJECTS="$PROJECT_ID"
   ```

4. 이전 호스트를 종료하고 같은 데이터 디렉터리에서 `npm start`를 다시 실행한다. 모델 및 프로세스 한도, 프로젝트 실행 권한, 런타임 준비 상태는 호스트 적용값을 확인한다. 허용할 프로젝트가 여럿이면 ID를 쉼표로 구분한다. 실행 기능을 끄려면 프로젝트 ID를 목록에서 빼고 호스트를 재시작한다.
5. 새 대화에서 [settling.csv](settling.csv)를 첨부하고 다음처럼 요청한다. “두 자식에게 위임해. 한 명은 `settling_ms`의 단위와 결측 행을 확인하고, 다른 한 명은 Python 분석 코드를 직접 작성해 중앙값과 모집단 표준편차를 구해. 결측을 제외한 CSV와 JSON을 만들고 분석 코드와 결과 링크를 알려 줘.” [optics.csv](optics.csv)에서는 `transmission_pct`의 중앙값과 90% 이상인 배치 수를 요청할 수 있다.

Execution에서 실행한 프로그램·인자·종료 상태를 확인하고, Artifacts에서 실제로 내려받은 소스·CSV·JSON을 연다. macOS에서는 `shasum -a 256 파일명`, Linux에서는 `sha256sum 파일명`으로 표시된 SHA-256과 대조할 수 있다. 대화와 파일을 다시 열 때도 같은 `ATHENA_DATA_DIR`을 쓴다. 새 위치로 옮기는 절차는 지원 범위에 포함되지 않는다.

## M2와 달라진 도구 계약

| 도구 | 입력과 결과 |
|---|---|
| `read`, `calculate_csv` | M2 계약을 유지한다. `calculate_csv`는 별도의 고정 Node 워커로 `statistics.json`을 생성한다. |
| `write_file({name,content})` | 자식 작업 공간에 UTF-8 파일을 생성하거나 수정한다. 응답의 바이트 수와 해시는 이 비공개 파일을 가리킨다. 이 시점에는 실행되지 않았고 다운로드할 산출물도 없다. |
| `read_file` | 자식은 작업 파일 이름, 허용된 첨부 `fileId`, 또는 허용된 `artifactId` 중 하나를 지정한다. 부모는 자식의 실제 결과를 `artifactId`로 검증하고 읽을 수 있다. |
| `run_command` | `language`(`python` 또는 `node`), `script`, `inputs`, `outputs`, 선택적 `args`를 받는다. 자식이 앞서 작성한 스크립트와 입력 스냅샷은 `/workspace`에서 읽고, 선언한 결과는 `/outputs`에 쓴다. 성공 응답에는 프로세스 ID, 출력, 종료 코드, 실제 소스와 결과 파일 참조가 있다. |
| `spawn_agent`, `send_to_agent`, `wait_for_agents` | 부모가 첨부를 골라 주거나 `artifactIds`로 다른 자식의 결과를 명시적으로 전달한다. 일반 실행이 허용된 프로젝트에서는 합류 응답의 `inspect`에 게시된 CSV·JSON 이름과 `read_file` 호출 인자가 들어 있다. 실제 읽기 여부는 이후 부모의 도구 기록에서 확인한다. 잘못된 결과는 `send_to_agent`로 수정을 요청할 수 있다. |

예를 들어 `run_command`의 입력은 `{"language":"python","script":"analysis.py","inputs":["settling.csv"],"outputs":["clean.csv","result.json"]}`이다. `inputs`는 필수다. 파일이 전혀 필요 없는 프로그램만 빈 배열을 사용한다. 문자열 입력은 작업 공간 이름이나 허용된 첨부의 고유한 이름이어야 한다. 별칭이 필요하면 `{name,fileId}` 또는 `{name,artifactId}`를 사용한다. `args`는 스크립트에 전달하는 개별 문자열이다. 모델은 셸 명령, 호스트 경로, 인터프리터 플래그, 환경 변수, 이미지 또는 작업 디렉터리를 지정할 수 없다.

입출력은 UTF-8 텍스트 파일이다. 쓰기·등록 형식은 `.py`, `.js`, `.mjs`, `.cjs`, `.ts`, `.csv`, `.json`, `.md`, `.txt`다. `.ts`는 보관할 수 있지만 직접 실행하는 형식은 아니다. 파일당 1 MiB, 입력 스냅샷 합계 2 MiB, 명령당 결과 8개와 실행 소스 하나, stdout·stderr 각 16 KiB 제한이 있다. 동일 이름의 결과를 다시 만들어도 이전 다운로드 주소는 이전 바이트를 가리킨다.

검증 이미지에서는 `/usr/local/bin/node`가 **v24.22.3**, `/usr/bin/python3`가 **Python 3.11.2**였다. 일반 명령은 호스트의 기본 셸에서 실행하지 않는다. 컨테이너에는 허용한 입력 복사본과 선언한 출력 파일만 연결한다. 루트 파일시스템은 읽기 전용이고 외부 네트워크는 꺼져 있다. 작업 코드는 비루트 사용자로 실행되며 CPU 1개, 메모리 192 MiB, PID 48개 한도가 적용된다. 운영자가 신뢰하는 로컬 Docker 데몬과 이미지가 전제다. 호스트 파일시스템 전체나 Docker 소켓을 자식에게 마운트하지 않는다.

## 실패와 재시작 확인

`npm run check && npm test`는 타입과 백엔드를 검사한다. 앞에서 설정한 `ATHENA_ANALYSIS_IMAGE`가 있어야 실제 Docker 검사가 실행된다. 환경 변수가 없으면 해당 검사는 `skipped`로 표시된다. 개별 검사 명령은 `node --test tests/jobs-analysis.test.ts`다. 이 검사는 비허가 파일·네트워크 접근, 실행 중 취소와 시간 초과, 호스트 `SIGKILL` 이후 컨테이너 제거를 확인한다. `tests/manager-orchestration.test.ts`는 Pi에 통제된 모델 응답을 공급하며, Docker 경로의 실제 종료 코드·로그와 결과 소유권을 검사한다. 실모델의 위임·코드 작성 증거는 [UI 인수 기록](acceptance.md)에서 별도로 확인한다.

실패한 명령은 완료한 파일로 표시하지 않는다. 호스트가 명령 도중 종료되면 복원 시 시도를 `interrupted`로 기록하며 자동 재실행하지 않는다. 독립적인 컨테이너 제한 시간이 지난 뒤 프로세스는 종료되지만, 갑자기 종료한 호스트의 비공개 임시 입력·출력 복사본은 디스크에 남을 수 있다. Docker 엔진이나 호스트 OS가 침해된 상황은 이 경계가 보호하지 않는다.

## 도구 추가 위치와 범위

`runtime/agent-tools.ts`의 `createPiToolLoadout`이 역할별 Pi 도구, 인자 스키마, 모델 지침을 등록한다. 새 도구의 실행·권한은 `runtime/manager.ts`에서 검사하고, 프로세스를 시작하는 도구는 `runtime/jobs.ts`의 동일한 큐와 시도 기록을 사용한다. 산출물은 `runtime/orchestration-journal.ts`에서 도구·프로세스·입력 버전에 연결한다. 브라우저 계약은 기존 `integrations/host-wire.d.ts`와 `integrations/task-manager.d.ts`를 함께 갱신한다. 외부 플러그인 로딩, 패키지 설치, 인터넷 도구, 임의 호스트 셸, 승인 서비스 및 자동 재시도는 제공하지 않는다.
