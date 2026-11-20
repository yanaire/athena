# Athena 기본 스킬과 연구 플러그인 제안

조사일: **2026-11-20**. 기준 코드는 [`feature/athena-m2-orchestration`의 `d8a9241`](https://github.com/yanaire/athena-1/commit/d8a9241c790fdd9f2e88de5af5ab9429c2eaf9ea)이다.

## 결정

**Athena 전용 스킬은 직접 작성하고, 수치 계산·문헌 검색·공학 해석은 검증된 외부 도구를 어댑터로 연결한다.** 기본 구성에는 연구 품질과 재현성에 필요한 작은 공통 기능을 두고, 생체신호·회로·CAD·대형 해석기는 분야별 선택 팩으로 제공하는 구성을 권한다.

이 변경에는 **자체 스킬 초안 12개, 외부 스킬 후보 10개, 플러그인/실행 도구 후보 28개**를 담았다. 자체 스킬은 실제 `SKILL.md` 파일로 작성했다. 외부 스킬 본문·스크립트·모델·데이터·바이너리를 복사하거나 설치하지 않았다. 런타임 연동과 실모델 인수는 다음 구현 작업이다.

## 읽는 순서

| 문서 | 내용 |
|---|---|
| [SKILLS.md](SKILLS.md) | 자체 스킬 12개의 역할·파일과 외부 스킬 후보 |
| [PLUGINS.md](PLUGINS.md) | 도구 28개의 실제 통합 방식·환경·공식 출처·인수 제안 |
| [LICENSE-REVIEW.md](LICENSE-REVIEW.md) | 확인한 라이선스, 개별 파일/의존성 경계, 도입 전 필요한 기록 |
| [IMPLEMENTATION.md](IMPLEMENTATION.md) | 작은 단위의 구현 순서와 OmO에 전달할 첫 작업 프롬프트 |
| [catalog.json](catalog.json) | 상태·출처·권리 정보를 가진 조사용 카탈로그. 설치 명세가 아님 |
| [자체 스킬 출처 기록](../../skills/PROVENANCE.md) | 직접 작성한 파일의 범위와 프로젝트 라이선스 상태 |

## 현재 코드와의 관계

M2에는 Athena TaskManager, 직속 자식 위임·합류, 읽기, 고정 CSV 프로세스, 산출물·취소·이력 보존이 있다. [`runtime/pi.ts`](https://github.com/yanaire/athena-1/blob/d8a9241c790fdd9f2e88de5af5ab9429c2eaf9ea/runtime/pi.ts)는 Pi SDK **1.5.2**를 사용하며 현재 resource loader의 skills/extensions 목록은 비어 있다. [`runtime/agent-tools.ts`](https://github.com/yanaire/athena-1/blob/d8a9241c790fdd9f2e88de5af5ab9429c2eaf9ea/runtime/agent-tools.ts)와 [`runtime/jobs.ts`](https://github.com/yanaire/athena-1/blob/d8a9241c790fdd9f2e88de5af5ab9429c2eaf9ea/runtime/jobs.ts)의 고정 도구를 일반 Python·임의 셸·MCP 기능으로 확대 해석하지 않는다.

따라서 이 브랜치에 파일이 존재한다는 사실만으로 Athena가 스킬을 자동 선택하거나 플러그인을 실행하지는 않는다. 새 기능은 기존 TaskManager의 task/attempt/취소/산출물 흐름에 연결한다. OmO는 구현에 사용하는 개발 도구이며 Athena 제품의 실행 의존성으로 추가하지 않는다.

## 권장 기본 구성

| 계층 | 먼저 제공할 것 | 배포 방식 제안 |
|---|---|---|
| 연구 스킬 | 요청 정리·위임·출처·단위·품질·계산·통계·그래프·문헌·작성·검토·지식 저장의 자체 스킬 12개 | 가벼운 텍스트/메타데이터. 필요한 본문만 읽기 |
| 공통 분석 | NumPy, SciPy, pandas, Matplotlib, Pint | 사용자가 팩을 활성화할 때 검증한 격리 Python 환경 준비 |
| 문헌과 PDF | pypdf, Crossref, PubMed, Europe PMC | 로컬 추출 + 직접 작성한 HTTP 어댑터 |
| 실행 환경 | uv 등의 환경 관리, 기존 Athena job/기록 서비스 | 선택 의존성의 잠금 파일·버전·설치 상태 관리 |
| 외부 연결 | 필요할 때 MCP SDK 기반 연결기 | 서버별 호환성·권한·라이선스 검토 후 활성화 |

‘기본 추천’은 모든 패키지·모델·해석기를 desktop 설치 파일에 포함하라는 뜻이 아니다. 카탈로그의 플러그인 후보 28개는 현재 `researched_not_integrated`이고 `enabledByDefault=false`, `binaryBundled=false`다. 외부 스킬 후보 10개는 미도입 상태이며 `defaultImport=false`로 별도 기록했다. 실제 환경의 버전 조합과 라이선스 고지를 확인한 뒤 설치/연결 상태를 갱신해야 한다.

## 선택 팩

| 분야 | 후보 | 첫 확인 목표 |
|---|---|---|
| 생체신호 | NeuroKit2, WFDB-Python | 합성 ECG 분석과 채널·단위·annotation 보존 |
| EEG/MEG | MNE-Python | 합성 신호의 epoch/PSD와 SI 단위 확인 |
| 회로 | ngspice, 이후 KiCad | RC 해석 검산, ERC/DRC 및 실제 export 파일 |
| 수학·기존 코드 | SymPy, 필요 시 GNU Octave | 식/초기조건/residual과 실제 수치 결과 비교 |
| 문서 고급 기능 | Docling, Tesseract, 선택 Office 스킬 | 표/OCR/문서 변환과 원문 위치·권리 보존 |
| 문헌 확장 | OpenAlex, Zotero | 분야 확장 검색과 기존 개인 라이브러리 읽기 |
| CAD·시스템 모델 | FreeCAD, OpenModelica | 자체 작은 형상·ODE 문제에서 결과 검증 |
| PDE·CFD·ML | FEniCSx, OpenFOAM Foundation, PyTorch | 구체적 연구 과제가 있을 때 분리 환경으로 도입 |

PyMuPDF는 기능 후보로 남기되 실제 배포 형태와 AGPL/상용 라이선스 선택을 확정하기 전에는 기본 번들에서 보류한다. 이는 AGPL 소프트웨어의 상업적 사용 자체를 금지로 분류하는 결정이 아니다. 자세한 조건과 근거는 [개별 후보](PLUGINS.md)와 [라이선스 검토](LICENSE-REVIEW.md)에 있다.

## 자체 작성과 외부 재사용

자체 스킬은 Athena의 현재 실행 기록, 연구 산출물, 실제 근거 검토에 맞춰 새로 작성했다. 각 파일에 사용 조건, 입력, 절차, 출력 양식, 작은 예시, 제안 인수 조건이 있다. 명령문 자체는 권한을 부여하지 않으며, 연결되지 않은 도구로 계산·검색·저장을 했다고 보고하지 않도록 작성했다.

외부 후보는 필요할 때 선별해 검토한다. K-Dense 6개 후보의 root/개별 스킬 라이선스와 Anthropic 문서 스킬 4개의 개별 라이선스를 특정 커밋에서 확인했다. 이 검토가 보조 스크립트·참고자료·폰트·모델·데이터의 재배포 검토까지 대신하지는 않는다.

기준 커밋에는 Athena 전체를 대상으로 한 root `LICENSE`가 없다. 이 변경은 자체 스킬에 임의의 MIT/Apache 라이선스를 붙이거나 프로젝트 전체를 재라이선스하지 않는다. 외부 공개·재배포 정책을 정할 때 자체 작성물의 조건을 명시하면 된다. 현재 개발을 계속하기 위해 외부 스킬을 복사할 필요는 없다.

## 바로 다음 구현

첫 PR은 **스킬 카탈로그 읽기 → 필요한 본문 로딩 → 적용된 스킬 버전/해시 기록 → 기능 부족 시 사실대로 표시**에 집중한다. 읽기 중심 스킬부터 기존 M2 사례에 연결하고, 그 다음 범용 실행기·분석 환경·문헌 어댑터를 순서대로 추가한다. 상세 범위와 인수 기준은 [IMPLEMENTATION.md](IMPLEMENTATION.md)를 따른다.

이번 변경의 [검증 기록](VALIDATION.md)은 형식·참조 검사와 제한된 스킬 응답 점검을 런타임/실모델 E2E 인수와 구분한다. 각 후보에 적힌 계산·다운로드·복구 예시는 향후 수행할 인수 조건이며 이번에 모두 실행했다고 해석하지 않는다.
