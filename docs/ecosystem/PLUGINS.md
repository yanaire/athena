# Athena 플러그인·실행 도구 후보

조사일: 2026-11-20. 기준: M2 `d8a9241`. **아래 28개는 연동 후보이며 설치·실행·제품 통합을 완료했다는 뜻이 아니다.**

라이브러리·HTTP API·CLI·프로토콜 SDK를 구분한다. 모두 Athena가 직접 작성하는 어댑터와 작업 기록 연결이 필요하다. 각 인수 예시는 이번 조사에서 설계한 시나리오이며 실행 결과가 아니다.

P0는 첫 추천 profile, P1은 선택 팩/다음 연결, P2는 구체적인 연구 수요에 따라 추가, HOLD는 배포·라이선스 경로 결정 후 검토를 뜻한다. 현재 활성화·바이너리 번들은 전부 false다.

| 후보 | 팩 | 우선순위 | 연결 방식 |
|---|---|---|---|
| [uv](#uv) | runtime | P0 | environment-manager |
| [MCP TypeScript SDK 기반 연결기](#mcp-bridge) | runtime | P1 | protocol-adapter |
| [NumPy](#numpy) | analysis | P0 | python-library |
| [SciPy](#scipy) | analysis | P0 | python-library |
| [pandas](#pandas) | analysis | P0 | python-library |
| [Matplotlib](#matplotlib) | analysis | P0 | python-library |
| [Pint](#pint) | analysis | P0 | python-library |
| [pypdf](#pypdf) | literature | P0 | python-library |
| [Crossref REST API](#crossref) | literature | P0 | http-api |
| [PubMed / NCBI E-utilities](#pubmed) | literature | P0 | http-api |
| [Europe PMC](#europe-pmc) | literature | P0 | http-api |
| [OpenAlex](#openalex) | literature-extended | P1 | http-api |
| [Docling](#docling) | document-advanced | P1 | python-library |
| [Zotero Local API](#zotero) | literature-extended | P1 | local-api |
| [Tesseract + tessdata_fast](#tesseract) | document-advanced | P1 | external-cli |
| [PyMuPDF](#pymupdf) | document-advanced | HOLD | python-library |
| [SymPy](#sympy) | math | P1 | python-library |
| [NeuroKit2](#neurokit2) | biosignal | P1 | python-library |
| [WFDB-Python](#wfdb) | biosignal | P1 | python-library |
| [MNE-Python](#mne) | eeg-meg | P1 | python-library |
| [ngspice](#ngspice) | circuits | P1 | external-cli |
| [KiCad CLI](#kicad) | circuits | P2 | external-cli |
| [FreeCAD](#freecad) | cad | P2 | external-cli |
| [OpenModelica](#openmodelica) | system-modeling | P2 | external-cli |
| [FEniCSx / DOLFINx](#fenicsx) | pde | P2 | python-native-stack |
| [OpenFOAM Foundation](#openfoam) | cfd | P2 | external-cli |
| [GNU Octave](#octave) | matlab-compatible | P2 | external-cli |
| [PyTorch](#pytorch) | machine-learning | P2 | python-native-stack |

<a id="uv"></a>
## uv

**용도:** 선택한 Python 분석 팩의 격리 환경과 잠금 파일 관리

**Athena 연결 제안:** Athena 환경 서비스가 uv를 호출하고 환경 ID·잠금 파일·설치 결과를 관리한다. 모델에 패키지 설치 권한을 자동 부여하지 않는다.

**필요 환경:** OS/CPU별 uv와 Python 공급 경로, 패키지 인덱스·lock 검증. FEniCSx 등은 별도 conda/container 환경을 허용한다.

**네트워크 / 인증:** 설치·업데이트 시 네트워크; 계산 중에는 선택 도구 정책에 따름 / 공개 인덱스 기본 키 불필요; 사설 인덱스는 별도 설정

**권리 확인:** 프로젝트 MIT OR Apache-2.0; uv가 설치하는 Python·wheel은 별도 조건

라이선스·정책 원문: [자료 1](https://github.com/astral-sh/uv/blob/main/LICENSE-MIT), [자료 2](https://github.com/astral-sh/uv/blob/main/LICENSE-APACHE)

기능·통합 공식 자료: [자료 1](https://docs.astral.sh/uv/), [자료 2](https://docs.astral.sh/uv/concepts/projects/sync/)

**첫 인수 제안 — 미실행:** 새 작업 환경에서 고정 lock을 재현하고 인터프리터 경로·의존성 목록을 기록한다. 설치 실패를 연결 성공으로 표시하지 않는다.

**범위:** uv 자체가 Rust로 작성됐다는 사실은 Athena 코어를 Rust로 재작성할 이유가 아니다.

<a id="mcp-bridge"></a>
## MCP TypeScript SDK 기반 연결기

**용도:** 필요한 외부 MCP 서버의 도구를 Athena가 관리하는 도구로 연결

**Athena 연결 제안:** 검증한 SDK 버전으로 서버 능력을 확인하고 도구 이름·스키마·타임아웃·취소·결과를 Athena task/attempt에 연결한다.

**필요 환경:** 현재 Pi 1.5.2 및 Node 실행 방식과 호환성 확인; 서버별 설치·인증·라이선스 검토

**네트워크 / 인증:** 서버별 stdio 또는 원격 연결; 서버가 요구하는 네트워크 권한 별도 / 서버별; 키는 설정 저장소에서 참조하고 이벤트에 기록하지 않음

**권리 확인:** 확인한 upstream은 MIT→Apache-2.0 전환 중이다. 미동의 기존 기여는 MIT, 새 코드/명세는 Apache-2.0, 명세 외 문서는 CC-BY-4.0이다.

라이선스·정책 원문: [자료 1](https://github.com/modelcontextprotocol/typescript-sdk/blob/5ee54ee30ddc00a914a3d981880f87fdce0e6246/LICENSE)

기능·통합 공식 자료: [자료 1](https://github.com/modelcontextprotocol/typescript-sdk), [자료 2](https://github.com/modelcontextprotocol/servers)

**첫 인수 제안 — 미실행:** 작은 로컬 서버의 도구 호출·오류·취소를 실제 호스트로 확인하고 허용하지 않은 도구가 등록되지 않는지 검사한다.

**범위:** 참고 서버는 교육용 예시를 포함한다. 설치만으로 생산용 품질이나 권한 격리를 보장하지 않는다. 프로토콜 버전을 고정·검증하고 예전 handshake를 무조건 가정하지 않는다.

<a id="numpy"></a>
## NumPy

**용도:** 배열·FFT·수치 계산

**Athena 연결 제안:** 격리 Python 작업자에서 계산하고 수치 결과·배열 파일·실행 로그를 artifacts에 등록한다.

**필요 환경:** Python 및 선택 wheel; BLAS 등 native 의존성

**네트워크 / 인증:** 로컬 계산; 설치 때 네트워크 / 불필요

**권리 확인:** 코어 BSD-3-Clause. 현재 source-build metadata는 BSD-3-Clause AND 0BSD AND MIT AND CC0-1.0이며 PyPI wheel의 추가 native 고지를 포함하지 않을 수 있다.

라이선스·정책 원문: [자료 1](https://github.com/numpy/numpy/blob/main/LICENSE.txt), [자료 2](https://github.com/numpy/numpy/blob/main/pyproject.toml)

기능·통합 공식 자료: [자료 1](https://numpy.org/doc/stable/reference/generated/numpy.fft.rfft.html), [자료 2](https://numpy.org/install/)

**첫 인수 제안 — 미실행:** fs=200 Hz인 합성 10 Hz 정현파의 FFT peak가 주파수 한 bin 이내인지 확인하고 seed·길이·단위를 보존한다.

**범위:** 실제 선택 wheel의 OpenBLAS·libgfortran 등 고지를 별도 수집한다.

<a id="scipy"></a>
## SciPy

**용도:** 필터·PSD·최적화·공학 모델 계산

**Athena 연결 제안:** 검증한 scipy.signal 등 API를 Python runner에서 호출한다.

**필요 환경:** NumPy 및 SciPy의 OS별 wheel/native 구성

**네트워크 / 인증:** 로컬 계산 / 불필요

**권리 확인:** 코어 BSD-3-Clause; LICENSES_bundled.txt 및 실제 배포 의존성 별도

라이선스·정책 원문: [자료 1](https://github.com/scipy/scipy/blob/main/LICENSE.txt), [자료 2](https://github.com/scipy/scipy/blob/main/LICENSES_bundled.txt)

기능·통합 공식 자료: [자료 1](https://docs.scipy.org/doc/scipy/reference/signal.html), [자료 2](https://scipy.org/install/)

**첫 인수 제안 — 미실행:** R=1 kΩ, C=100 nF RC 저역통과 모델의 차단 주파수 약 1591.55 Hz와 그 지점 응답 약 -3.0103 dB를 독립 계산과 비교한다.

**범위:** 필터 적용 전에 샘플링률·단위·경계 처리·위상 영향을 기록한다.

<a id="pandas"></a>
## pandas

**용도:** 표 데이터 검사·변환·집계

**Athena 연결 제안:** table_inspect/table_transform 같은 Athena 어댑터 후보로 CSV를 읽고 원본과 변환본을 분리한다.

**필요 환경:** Python, NumPy; Excel/Parquet 등 선택 엔진은 별도 의존성

**네트워크 / 인증:** 로컬 계산 / 불필요

**권리 확인:** 코어 BSD-3-Clause; 선택 파일 엔진과 실제 wheel 조건 별도

라이선스·정책 원문: [자료 1](https://github.com/pandas-dev/pandas/blob/main/LICENSE)

기능·통합 공식 자료: [자료 1](https://pandas.pydata.org/docs/reference/api/pandas.read_csv.html), [자료 2](https://pandas.pydata.org/docs/getting_started/install.html)

**첫 인수 제안 — 미실행:** 직접 만든 결측·중복 CSV에서 행 수·열 타입·결측 수를 재현하고, 삭제/보간 없이 검사 결과를 만든다.

**범위:** M2 calculate_csv를 일반 pandas 실행기로 이미 연결했다고 표시하지 않는다.

<a id="matplotlib"></a>
## Matplotlib

**용도:** 근거 데이터와 연결된 정적 과학 그래프

**Athena 연결 제안:** headless Agg 경로에서 PNG/SVG/PDF를 생성하고 데이터·코드·캡션을 함께 등록한다.

**필요 환경:** Python, NumPy, 폰트·렌더러; 실제 환경별 출력 확인

**네트워크 / 인증:** 로컬 렌더링 / 불필요

**권리 확인:** PSF 기반 Matplotlib 자체 License. 현재 build metadata는 PSF-2.0 AND MIT AND CC0-1.0 AND OFL-1.1 AND Bitstream-Vera AND LicenseRef-Public-Domain을 선언한다.

라이선스·정책 원문: [자료 1](https://matplotlib.org/stable/project/license.html), [자료 2](https://github.com/matplotlib/matplotlib/blob/main/LICENSE/LICENSE), [자료 3](https://github.com/matplotlib/matplotlib/blob/main/meson.build)

기능·통합 공식 자료: [자료 1](https://matplotlib.org/stable/users/explain/figure/backends.html), [자료 2](https://matplotlib.org/stable/install/)

**첫 인수 제안 — 미실행:** 알려진 RC 응답을 그려 축 단위·범례·출처 데이터 링크를 확인하고 이미지 파일을 실제로 연다.

**범위:** BSD로 단순 분류하지 않는다. 라이선스·저작권 유지와 해당 변경 배포 시 변경 요약을 검토하며 폰트 권리도 별도로 기록한다.

<a id="pint"></a>
## Pint

**용도:** 단위 변환·차원 검사

**Athena 연결 제안:** convert_units/dimension_check 후보를 Python 작업자로 제공한다.

**필요 환경:** 선택 Pint release에 맞는 Python 버전과 단위 레지스트리

**네트워크 / 인증:** 로컬 계산 / 불필요

**권리 확인:** 프로젝트 BSD-3-Clause; 사용자 정의 단위 파일의 출처도 기록

라이선스·정책 원문: [자료 1](https://github.com/hgrecco/pint/blob/master/LICENSE)

기능·통합 공식 자료: [자료 1](https://pint.readthedocs.io/en/0.26.2/getting/overview.html), [자료 2](https://pint.readthedocs.io/en/0.26/getting/index.html)

**첫 인수 제안 — 미실행:** 1000 µV=1 mV와 1 kΩ×100 nF=100 µs를 확인하고 전압+시간 연산을 거부한다.

**범위:** stable 문서와 master의 Python 요구가 다를 수 있어 최신판을 무조건 한 환경에 설치하지 않는다.

<a id="pypdf"></a>
## pypdf

**용도:** 텍스트층 PDF의 페이지별 추출

**Athena 연결 제안:** 로컬 Python 작업자가 text·page·추출 상태를 반환하고 원본 해시와 연결한다.

**필요 환경:** Python; 암호화 등 optional dependency는 별도 선택

**네트워크 / 인증:** 로컬 추출 / 불필요

**권리 확인:** BSD-3-Clause; 입력 PDF의 원문 권리는 별도

라이선스·정책 원문: [자료 1](https://github.com/py-pdf/pypdf/blob/main/LICENSE)

기능·통합 공식 자료: [자료 1](https://pypdf.readthedocs.io/en/stable/user/extract-text.html)

**첫 인수 제안 — 미실행:** 자체 제작 텍스트 PDF와 스캔 PDF에서 페이지 출처를 보존하고, 스캔 문서에 OCR 필요 상태를 반환한다.

**범위:** 복잡한 읽기 순서·표 구조를 항상 복원한다고 약속하지 않는다.

<a id="crossref"></a>
## Crossref REST API

**용도:** DOI와 서지 정보 정규화·대조

**Athena 연결 제안:** 직접 작성한 TypeScript HTTP 어댑터가 DOI·제목·저자·연도를 비교하고 요청/응답 출처를 저장한다.

**필요 환경:** 캐시·rate-limit/backoff·식별 가능한 User-Agent·선택 mailto

**네트워크 / 인증:** 원격 메타데이터 질의 / 공개 API 키 불필요; 유료 Metadata Plus는 별도 인증

**권리 확인:** HTTP 서비스/데이터 조건 대상. 메타데이터의 초록 등 저작권 자료를 별도로 구분한다.

라이선스·정책 원문: [자료 1](https://www.crossref.org/documentation/retrieve-metadata)

기능·통합 공식 자료: [자료 1](https://www.crossref.org/documentation/retrieve-metadata/rest-api), [자료 2](https://www.crossref.org/documentation/retrieve-metadata/rest-api/access-and-authentication/)

**첫 인수 제안 — 미실행:** 확인 가능한 DOI와 틀린 서지 입력을 대조해 일치·불일치·조회 실패를 구분한다.

**범위:** 서지 일치는 논문 주장의 진실성이나 원문 재배포 허락을 뜻하지 않는다.

<a id="pubmed"></a>
## PubMed / NCBI E-utilities

**용도:** 생명의학 문헌 검색

**Athena 연결 제안:** TypeScript HTTP로 ESearch→ESummary/EFetch를 호출하고 검색식·PMID/DOI·조회일·부분 결과를 보존한다.

**필요 환경:** NCBI tool/email 지침, 요청 제한 처리, 응답 형식 검증

**네트워크 / 인증:** 원격 문헌 메타데이터 질의 / 기본 무키 경로; 확대 사용 키는 선택 설정

**권리 확인:** NCBI 서비스 정책과 콘텐츠 권리 적용. PubMed 초록은 출판사·저자 권리가 있을 수 있다.

라이선스·정책 원문: [자료 1](https://www.ncbi.nlm.nih.gov/home/about/policies/)

기능·통합 공식 자료: [자료 1](https://www.ncbi.nlm.nih.gov/home/develop/api/), [자료 2](https://www.ncbi.nlm.nih.gov/books/NBK53593/)

**첫 인수 제안 — 미실행:** 고정 검색식의 실제 조회 응답과 query log를 저장하고 네트워크 실패를 논문 0건과 구분한다.

**범위:** PubMed 초록과 PMC full text를 같은 수준의 근거로 취급하지 않는다.

<a id="europe-pmc"></a>
## Europe PMC

**용도:** 생명의학 검색 및 허용된 OA full-text XML 보완

**Athena 연결 제안:** 공식 REST를 통해 검색·식별자 연결·제공 가능한 fullTextXML을 수집한다.

**필요 환경:** 운영 API 확인, 논문별 라이선스 및 원문 제공 상태 저장

**네트워크 / 인증:** 원격 문헌 질의·허용된 원문 다운로드 / 공개 REST 예제는 별도 키 없이 사용

**권리 확인:** 논문별 라이선스. OA subset 안에서도 권리 조건은 동일하지 않다.

라이선스·정책 원문: [자료 1](https://dev.europepmc.org/downloads/openaccess), [자료 2](https://dev.europepmc.org/Copyright)

기능·통합 공식 자료: [자료 1](https://dev.europepmc.org/RestfulWebService), [자료 2](https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=p53)

**첫 인수 제안 — 미실행:** 실제 OA 원문 1건에서 PMCID·원문 라이선스·본문 위치를 저장하고 원문 미제공 사례를 구분한다.

**범위:** 이번 설명 문서 확인은 공식 개발 사이트를 이용했다. 통계 수치는 사용하지 않았고 연동 때 운영 API 응답을 재검증해야 한다.

<a id="openalex"></a>
## OpenAlex

**용도:** 전 학문 분야·인용망 확장 검색

**Athena 연결 제안:** 직접 TypeScript 어댑터로 DOI/ORCID/OpenAlex ID·cursor·부분 결과를 관리한다.

**필요 환경:** 현재 API 정책, pagination·budget·캐시 처리

**네트워크 / 인증:** 원격 메타데이터 질의 / 현재 기본 질의는 무키 가능; 확대 사용과 첫 페이지 이후 cursor paging은 키 필요

**권리 확인:** OpenAlex 데이터 CC0; 연결된 논문 원문·PDF는 별도 권리

라이선스·정책 원문: [자료 1](https://help.openalex.org/api/), [자료 2](https://creativecommons.org/publicdomain/zero/1.0/legalcode.en)

기능·통합 공식 자료: [자료 1](https://help.openalex.org/api/authentication/), [자료 2](https://help.openalex.org/api/)

**첫 인수 제안 — 미실행:** 한 DOI의 실제 레코드를 확인하고 키 없는 pagination 제한을 완전한 검색 결과로 표시하지 않는다.

**범위:** 서비스 인증/요금은 구현 당시 재확인한다. 사용자 이메일로 임의 가입하거나 자동 키 발급을 요청하지 않는다.

<a id="docling"></a>
## Docling

**용도:** 문서 구조·표·OCR 기반 추출

**Athena 연결 제안:** 관리 Python 환경에서 DoclingDocument JSON/Markdown을 저장한다. MCP는 선택 통합 경로다.

**필요 환경:** 선택 파서/OCR/모델·가중치 revision·모델 카드; 자원 제한

**네트워크 / 인증:** 모델 최초 다운로드 가능; 이후 로컬 처리 구성. 원격 모델 서비스는 별도 활성화 / 로컬 경로는 키 불필요; 원격 모델 선택 시 별도 키

**권리 확인:** 코드 MIT. 모델 가중치·OCR 백엔드·폰트 등은 각각 별도 조건

라이선스·정책 원문: [자료 1](https://github.com/docling-project/docling/blob/main/LICENSE)

기능·통합 공식 자료: [자료 1](https://github.com/docling-project/docling), [자료 2](https://docling-project.github.io/docling/usage/advanced_options/), [자료 3](https://docling-project.github.io/docling/usage/model_catalog/)

**첫 인수 제안 — 미실행:** 자체 표 PDF를 변환해 표·페이지 위치를 원본과 비교하고, 모델을 준비한 뒤 로컬 처리 경로를 확인한다.

**범위:** 모델 다운로드 권한과 사용자 문서 원격 전송 권한을 분리한다.

<a id="zotero"></a>
## Zotero Local API

**용도:** 사용자의 기존 문헌 라이브러리 연결

**Athena 연결 제안:** 설치된 Zotero의 localhost:23119/api/에 Node 백엔드로 읽기 연결한다. DB 파일을 직접 수정하지 않는다.

**필요 환경:** 사용자가 활성화한 Local API, 설치 버전·서버 ID·데이터 버전 확인

**네트워크 / 인증:** 로컬 API는 오프라인 가능; Web API는 별도 제공자 / 로컬 읽기는 무인증; Zotero 10+ 쓰기는 사용자 로컬 승인 키 필요

**권리 확인:** Zotero 앱 코드 AGPLv3. 기본 제안은 앱 비번들·공식 API 연결이며 첨부 PDF 권리는 별도

라이선스·정책 원문: [자료 1](https://github.com/zotero/zotero/blob/main/COPYING)

기능·통합 공식 자료: [자료 1](https://www.zotero.org/support/dev/web_api/v3/local_api), [자료 2](https://www.zotero.org/support/dev/web_api/v3/basics)

**첫 인수 제안 — 미실행:** 로컬 라이브러리 1개 항목의 식별자/버전을 읽고 API 비활성화를 명시적으로 표시한다.

**범위:** API 연동·앱 번들·수정 포크를 서로 다른 배포 형태로 기록한다. 로컬 키와 Web API 키를 혼동하지 않는다.

<a id="tesseract"></a>
## Tesseract + tessdata_fast

**용도:** 스캔 문서 OCR

**Athena 연결 제안:** 페이지 이미지에 CLI를 실행하고 text/hOCR/TSV를 원본 페이지와 연결한다.

**필요 환경:** 엔진·선택 언어 데이터·PDF→이미지 렌더러는 별도 선정

**네트워크 / 인증:** 설치/언어 데이터 다운로드 후 로컬 OCR / 불필요

**권리 확인:** 확인한 엔진 및 공식 tessdata_fast 각각 Apache-2.0. 다른 언어 모델·PDF 렌더러는 별도

라이선스·정책 원문: [자료 1](https://github.com/tesseract-ocr/tesseract/blob/main/LICENSE), [자료 2](https://github.com/tesseract-ocr/tessdata_fast/blob/main/LICENSE)

기능·통합 공식 자료: [자료 1](https://tesseract-ocr.github.io/tessdoc/Command-Line-Usage.html)

**첫 인수 제안 — 미실행:** 자체 작성한 숫자·단위 페이지를 OCR하고 원본과 대조할 수 있는 위치 정보와 오류 상태를 남긴다.

**범위:** OCR 텍스트를 검토 없이 원문과 동일한 근거로 승격하지 않는다.

<a id="pymupdf"></a>
## PyMuPDF

**용도:** PDF 렌더링·좌표·이미지·텍스트 통합 처리 후보

**Athena 연결 제안:** 배포 형태와 라이선스 선택을 결정한 후 Python 작업자로 통합 여부를 판단한다.

**필요 환경:** 선택 AGPL 준수 경로 또는 상용 계약; MuPDF 구성 검토

**네트워크 / 인증:** 로컬 처리 구성 가능 / 상용 선택 시 계약 설정은 별도

**권리 확인:** 공식 AGPL 또는 상용 라이선스 선택. 저장소 COPYING은 AGPLv3 원문

라이선스·정책 원문: [자료 1](https://github.com/pymupdf/PyMuPDF/blob/main/COPYING), [자료 2](https://pymupdf.readthedocs.io/en/latest/about.html)

기능·통합 공식 자료: [자료 1](https://pymupdf.readthedocs.io/en/latest/about.html)

**첫 인수 제안 — 미실행:** 배포 정책을 정한 뒤 자체 PDF에서 페이지 렌더링·추출 좌표를 대조한다.

**범위:** AGPL은 상업적 사용 금지와 다르다. 프로세스를 분리했다는 사실만으로 의무가 없어진다고 결론내리지 않는다.

<a id="sympy"></a>
## SymPy

**용도:** 기호식·미분방정식·수치 결과 교차 검증

**Athena 연결 제안:** Python runner가 식/가정/해/수치 residual을 반환한다.

**필요 환경:** Python 및 선택 dependency lock

**네트워크 / 인증:** 로컬 계산 / 불필요

**권리 확인:** 코어 New BSD; 현재 metadata는 BSD-3-Clause AND MIT

라이선스·정책 원문: [자료 1](https://github.com/sympy/sympy/blob/master/LICENSE), [자료 2](https://github.com/sympy/sympy/blob/master/pyproject.toml)

기능·통합 공식 자료: [자료 1](https://docs.sympy.org/latest/guides/solving/index.html)

**첫 인수 제안 — 미실행:** RC ODE 해를 유도하고 초기조건·방정식 residual과 독립 수치값을 확인한다.

**범위:** 기호 해가 물리 가정까지 검증한 것은 아니다.

<a id="neurokit2"></a>
## NeuroKit2

**용도:** ECG/PPG/EDA/EMG 연구 전처리

**Athena 연결 제안:** 고정 파라미터로 전처리·peak·품질 결과를 반환하고 원신호를 보존한다.

**필요 환경:** Python 과학 환경, 샘플링률·채널·단위 확인

**네트워크 / 인증:** 로컬 분석; 선택 dataset 다운로드는 별도 / 불필요

**권리 확인:** MIT; 사용하는 데이터셋은 별도

라이선스·정책 원문: [자료 1](https://github.com/neuropsychology/NeuroKit/blob/master/LICENSE)

기능·통합 공식 자료: [자료 1](https://neuropsychology.github.io/NeuroKit/functions/ecg.html), [자료 2](https://neuropsychology.github.io/NeuroKit/installation.html)

**첫 인수 제안 — 미실행:** 고정 seed 합성 ECG의 cleaned signal·peaks·경고를 저장하고 raw와 겹쳐 확인한다.

**범위:** 연구 파이프라인 확인으로 한정하며 합성 입력 성공을 임상 성능으로 보고하지 않는다.

<a id="wfdb"></a>
## WFDB-Python

**용도:** 생체신호 기록·annotation 읽기/쓰기

**Athena 연결 제안:** WFDB 레코드의 채널·fs·단위·gain·annotation을 구조화해 반환한다.

**필요 환경:** Python 및 원본 .hea/.dat 또는 자체 합성 기록

**네트워크 / 인증:** 로컬 I/O; PhysioNet 다운로드는 별도 / 로컬 입력 키 불필요; 데이터셋 접근 권한은 제공처별

**권리 확인:** WFDB-Python MIT; PhysioNet 데이터의 이용조건은 별도. 예: MIT-BIH 1.0.0은 ODC-By 1.0

라이선스·정책 원문: [자료 1](https://github.com/MIT-LCP/wfdb-python/blob/main/LICENSE), [자료 2](https://www.physionet.org/content/mitdb/1.0.0/)

기능·통합 공식 자료: [자료 1](https://wfdb.io/software/python.html), [자료 2](https://wfdb.readthedocs.io/en/latest/wfdb.html)

**첫 인수 제안 — 미실행:** 직접 생성한 2채널 신호와 annotation을 쓰고 다시 읽어 fs·단위·gain·표본값을 비교한다.

**범위:** 초기 인수에 외부 의료 데이터 다운로드가 필수는 아니다.

<a id="mne"></a>
## MNE-Python

**용도:** EEG/MEG 기록·epoch·PSD 분석

**Athena 연결 제안:** 관리 Python 작업자가 Raw/epochs/PSD를 처리하고 채널/단위를 보존한다.

**필요 환경:** Python 환경, 채널 유형·SI 단위·이벤트 정의

**네트워크 / 인증:** 로컬 처리; sample dataset 자동 다운로드 제외 / 불필요

**권리 확인:** 코어 BSD-3-Clause; sample dataset·폰트·선택 GUI 의존성 별도

라이선스·정책 원문: [자료 1](https://github.com/mne-tools/mne-python/blob/main/LICENSE.txt)

기능·통합 공식 자료: [자료 1](https://mne.tools/stable/generated/mne.io.RawArray.html), [자료 2](https://github.com/mne-tools/mne-python)

**첫 인수 제안 — 미실행:** 합성 RawArray 10 Hz 신호와 이벤트로 epochs/PSD를 만들고 EEG 전압 단위 변환을 확인한다.

**범위:** 모든 파일 포맷/OS 경로가 이 예제로 검증되는 것은 아니다.

<a id="ngspice"></a>
## ngspice

**용도:** 회로 transient/AC/DC 해석

**Athena 연결 제안:** ngspice -b -r result.raw -o run.log circuit.cir 형태의 별도 설치 CLI를 Athena job에서 실행한다.

**필요 환경:** OS별 설치한 ngspice, 자체 netlist·허용된 모델; macOS는 공식 안내 설치 경로 확인

**네트워크 / 인증:** 기본 로컬 시뮬레이션 / 불필요

**권리 확인:** 주요 코드 modified BSD/New BSD; tclspice·numparam LGPLv2, XSPICE public-domain 등 구성별 차이

라이선스·정책 원문: [자료 1](https://ngspice.sourceforge.io/docs/ngspice-manual.pdf)

기능·통합 공식 자료: [자료 1](https://ngspice.sourceforge.io/ngspice-tutorial.html), [자료 2](https://ngspice.sourceforge.io/shared.html), [자료 3](https://ngspice.sourceforge.io/download.html)

**첫 인수 제안 — 미실행:** R=1 kΩ, C=1 µF, 1 V step인 자체 RC 회로에서 τ=1 ms와 V(τ)≈0.632 V를 비교하고 raw/log/JSON을 저장한다.

**범위:** 제조사 모델 라이선스는 별도. PSpice/LTspice 암호화 모델 전체 호환을 가정하지 않는다.

<a id="kicad"></a>
## KiCad CLI

**용도:** 회로/PCB ERC·DRC·제조 파일 내보내기

**Athena 연결 제안:** kicad-cli의 검증·export 명령을 버전별 어댑터에서 사용한다.

**필요 환경:** 로컬 KiCad 및 사용한 symbol/footprint/3D 모델 라이브러리

**네트워크 / 인증:** 기본 로컬; 라이브러리 업데이트 별도 / 불필요

**권리 확인:** 주요 코드 GPL-3.0-or-later. 공식 라이브러리 CC-BY-SA-4.0 및 설계/생성물에 관한 예외; 라이브러리 모음 재배포 조건은 유지

라이선스·정책 원문: [자료 1](https://www.kicad.org/about/licenses/), [자료 2](https://www.kicad.org/libraries/license/)

기능·통합 공식 자료: [자료 1](https://docs.kicad.org/10.0/en/cli/cli.html), [자료 2](https://www.kicad.org/download/)

**첫 인수 제안 — 미실행:** 자체 작은 PCB의 정상판과 의도한 DRC 오류판을 구분하고 실제 export 파일을 다시 확인한다.

**범위:** 프로그램·문서·라이브러리를 같은 라이선스로 표기하지 않는다.

<a id="freecad"></a>
## FreeCAD

**용도:** 파라메트릭 형상·치수·STEP 생성

**Athena 연결 제안:** FreeCADCmd와 Python Part API를 별도 프로세스로 사용한다.

**필요 환경:** FreeCAD·OpenCascade·Qt 등 선택 설치 구성; GUI workbench의 headless 지원 확인

**네트워크 / 인증:** 기본 로컬 / 불필요

**권리 확인:** 현행 개발 정책 LGPL-2.1-or-later; 선택 release·파일·서드파티 구성별 재확인

라이선스·정책 원문: [자료 1](https://github.com/FreeCAD/FreeCAD/blob/main/LICENSE), [자료 2](https://freecad.github.io/Website/dev/code/copyright/)

기능·통합 공식 자료: [자료 1](https://github.com/FreeCAD/FreeCAD-documentation/blob/main/wiki/Start_up_and_Configuration.md), [자료 2](https://freecad.github.io/Website/dev/setup/dependencies/)

**첫 인수 제안 — 미실행:** 10×20×30 mm 자체 직육면체의 부피 6000 mm³를 확인하고 STEP export 후 재개방한다.

**범위:** 형상 포맷 교환을 다른 CAD의 전체 feature tree 호환으로 표현하지 않는다.

<a id="openmodelica"></a>
## OpenModelica

**용도:** Modelica 시스템 모델 시뮬레이션

**Athena 연결 제안:** omc Script.mos 또는 설치 compiler를 사용하는 OMPython으로 결과를 받는다.

**필요 환경:** 로컬 compiler·C toolchain·모델 라이브러리; macOS 설치 조건 확인

**네트워크 / 인증:** 기본 로컬 / 불필요; 별도 라이선스 경로는 계약 조건 확인

**권리 확인:** compiler는 AGPLv3 OR OSMC-PL 1.8. runtime은 별도 BSD New/AGPL/OSMC 선택 조건; 일반 전체 MIT/BSD로 분류 불가

라이선스·정책 원문: [자료 1](https://github.com/OpenModelica/OpenModelica/blob/master/OSMC-License.txt), [자료 2](https://github.com/OpenModelica/OpenModelica/blob/master/OSMC-Runtime-License.txt)

기능·통합 공식 자료: [자료 1](https://openmodelica.org/doc/OpenModelicaUsersGuide/1.26/introduction.html), [자료 2](https://openmodelica.org/doc/OpenModelicaUsersGuide/latest/ompython.html), [자료 3](https://openmodelica.org/download/download-mac/)

**첫 인수 제안 — 미실행:** 자체 모델 der(x)=-x, x(0)=1에서 x(1)=exp(-1)을 비교하고 solver/tolerance를 남긴다.

**범위:** OSMC 회원에게 제공되는 별도 선택권을 모든 사용자에게 적용하지 않는다.

<a id="fenicsx"></a>
## FEniCSx / DOLFINx

**용도:** 유한요소 PDE 모델 연구

**Athena 연결 제안:** 별도 conda/container 환경의 DOLFINx Python 작업자를 Athena job으로 관리한다.

**필요 환경:** DOLFINx·Basix·UFL·FFCx·PETSc·MPI 등; OS와 native 환경을 별도 검증

**네트워크 / 인증:** 로컬 계산; 환경 설치 네트워크 / 불필요

**권리 확인:** DOLFINx LGPL-3.0-or-later, Basix MIT 등 여러 구성 요소. 전체 팩의 라이선스는 각각 기록

라이선스·정책 원문: [자료 1](https://github.com/FEniCS/dolfinx/blob/main/COPYING.LESSER), [자료 2](https://github.com/FEniCS/basix/blob/main/LICENSE), [자료 3](https://github.com/FEniCS/dolfinx#license)

기능·통합 공식 자료: [자료 1](https://fenicsproject.org/download/), [자료 2](https://docs.fenicsproject.org/dolfinx/v0.11.0/python/demos/demo_poisson.html)

**첫 인수 제안 — 미실행:** 자체 manufactured Poisson 문제에서 mesh를 세분화하며 해석해 대비 오차 감소를 검사한다.

**범위:** 고급 선택 팩. 기본 Python 환경이나 모든 Windows/macOS에 동일 설치가 된다고 가정하지 않는다.

<a id="openfoam"></a>
## OpenFOAM Foundation

**용도:** 유체 해석 CLI 파이프라인

**Athena 연결 제안:** 별도 설치 환경에서 mesh·solver·postprocess를 단계별 job으로 실행하고 필드·로그를 보존한다.

**필요 환경:** Foundation 배포판을 명시; Linux 중심, 다른 OS는 공식 가상화/환경 경로 확인

**네트워크 / 인증:** 기본 로컬; 환경 설치 네트워크 / 불필요

**권리 확인:** GPL 계열; 선택 Foundation release의 COPYING·파일 고지를 확인. OpenCFD 계열과 혼합 금지

라이선스·정책 원문: [자료 1](https://openfoam.org/licence/), [자료 2](https://github.com/OpenFOAM/OpenFOAM-dev/blob/master/COPYING)

기능·통합 공식 자료: [자료 1](https://openfoam.org/download/), [자료 2](https://doc.cfd.direct/openfoam/user-guide-v14/backwardstep)

**첫 인수 제안 — 미실행:** 자체 층류 채널에서 질량 보존과 압력 구배를 해석해와 비교하고 mesh 의존성을 기록한다.

**범위:** COMSOL/ANSYS 프로젝트의 자동 호환 또는 macOS native 실행을 가정하지 않는다.

<a id="octave"></a>
## GNU Octave

**용도:** 기존 .m 수치 연구 스크립트 실행

**Athena 연결 제안:** octave --no-gui --quiet analysis.m 형태로 로그·수치 결과를 수집한다.

**필요 환경:** 로컬 Octave와 선택 package의 버전·라이선스

**네트워크 / 인증:** 기본 로컬 / 불필요

**권리 확인:** GPL-3.0-or-later; 선택 package는 각각 검토

라이선스·정책 원문: [자료 1](https://docs.octave.org/latest/Copying.html), [자료 2](https://octave.org/governance)

기능·통합 공식 자료: [자료 1](https://docs.octave.org/latest/Invoking-Octave-from-the-Command-Line.html), [자료 2](https://octave.org/download.html)

**첫 인수 제안 — 미실행:** 자체 Ax=b 문제의 residual과 ODE 해를 독립 결과에 대조한다.

**범위:** MATLAB toolbox·Simulink 전체 호환을 뜻하지 않는다.

<a id="pytorch"></a>
## PyTorch

**용도:** 구체적 연구 과제가 생긴 뒤 학습·평가 기능

**Athena 연결 제안:** 별도 CPU/GPU profile에서 학습 job·checkpoint·평가 artifact를 보존한다.

**필요 환경:** PyTorch·native/GPU 구성, 데이터 분할·seed·선택 weights의 별도 권리

**네트워크 / 인증:** 환경·가중치 다운로드는 별도; 학습은 선택 로컬 환경 / 모델/데이터 제공처별

**권리 확인:** 코어 BSD-style. 현재 metadata는 Apache-2.0 AND Apache-2.0 WITH LLVM-exception AND BSD-2-Clause AND BSD-3-Clause AND BSL-1.0 AND ISC AND MIT AND Zlib

라이선스·정책 원문: [자료 1](https://github.com/pytorch/pytorch/blob/main/LICENSE), [자료 2](https://github.com/pytorch/pytorch/blob/main/pyproject.toml)

기능·통합 공식 자료: [자료 1](https://pytorch.org/get-started/locally/)

**첫 인수 제안 — 미실행:** 작은 자체 합성 회귀 문제를 CPU로 학습하고 checkpoint 재적재 후 예측을 비교한다.

**범위:** 첫 기본 팩에서 제외한다. GPU/모델 가중치/학습 데이터 조건을 소프트웨어 라이선스로 대신하지 않는다.

## 환경과 배포 결정

첫 분석 환경은 NumPy·SciPy·pandas·Matplotlib·Pint·pypdf를 함께 resolve할 수 있는 실제 Python/OS 조합으로 결정한다. 특정 Python 버전이나 모든 최신 release의 동시 호환을 이 문서로 인증하지 않는다. 기본 desktop 바이너리에 모든 환경을 포함할 필요도 없다.

ngspice·KiCad·FreeCAD·OpenModelica·Octave는 별도 설치 프로그램 연결부터, FEniCSx·OpenFOAM·PyTorch는 분리 환경부터 검토한다. 프로세스 분리는 실행·배포 설계이며 라이선스 의무의 면제 조건으로 취급하지 않는다.

[라이선스 검토](LICENSE-REVIEW.md) · [구현 순서](IMPLEMENTATION.md) · [전체 카탈로그](catalog.json)
