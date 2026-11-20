# 라이선스와 출처 검토 기록

검토일: **2026-11-20**. 적용 범위는 이번 브랜치의 조사 문서와 신규 자체 스킬이다. 기존 Athena 전체 의존성의 법적 상태나 모든 후보의 배포 가능성을 인증한 문서는 아니다.

## 1. 이번 변경에 실제로 포함한 것

| 종류 | 포함 여부 | 처리 |
|---|---|---|
| Athena 자체 연구 스킬 12개 | 포함 | 요청과 Athena 실행 계약을 바탕으로 새로 작성. [출처 기록](../../skills/PROVENANCE.md) |
| 공식 자료의 사실을 자체 문장으로 요약한 카탈로그 | 포함 | 근거 URL·조회일·일부 license blob SHA 기록 |
| 외부 SKILL.md 본문, 보조 코드, 문서 템플릿 | 미포함 | 후보와 라이선스 링크만 기록 |
| 외부 라이브러리·CLI·모델 가중치·데이터·폰트 | 미포함 | 설치/다운로드/번들 수행 없음 |
| 기존 프로젝트 전체에 대한 새 라이선스 | 미포함 | 기준 M2에 root LICENSE가 없으며 임의로 선택하지 않음 |

문서에서 권장하는 도구 이름과 공개 API를 사용한다고 그 프로젝트의 코드·문서 라이선스를 Athena 전체에 복사 적용하는 것은 아니다. 반대로 실제 코드를 가져오거나 배포 파일에 포함할 때에는 해당 원문의 조건을 따라야 한다. 프로그램·스킬 본문·문서·모델·데이터를 각각 기록한다.

## 2. 외부 스킬: 특정 커밋에서 확인한 사실

### K-Dense scientific-agent-skills

확인한 저장소는 [`K-Dense-AI/scientific-agent-skills`](https://github.com/K-Dense-AI/scientific-agent-skills/tree/ec59a29a03d5c40f73ab40878df04860bc00e876), 커밋은 `ec59a29a03d5c40f73ab40878df04860bc00e876`이다.

해당 [`LICENSE.md`](https://github.com/K-Dense-AI/scientific-agent-skills/blob/ec59a29a03d5c40f73ab40878df04860bc00e876/LICENSE.md)는 MIT이며 저작권 표기는 `Copyright (c) 2025 K-Dense Inc.`다. README는 개별 스킬의 라이선스가 다를 수 있음을 안내한다. 아래 6개는 실제 SKILL.md의 license metadata도 MIT로 확인했다.

| 후보 | 확인한 SKILL.md |
|---|---|
| scientific-critical-thinking | [고정 커밋의 파일](https://github.com/K-Dense-AI/scientific-agent-skills/blob/ec59a29a03d5c40f73ab40878df04860bc00e876/skills/scientific-critical-thinking/SKILL.md) |
| statistical-analysis | [고정 커밋의 파일](https://github.com/K-Dense-AI/scientific-agent-skills/blob/ec59a29a03d5c40f73ab40878df04860bc00e876/skills/statistical-analysis/SKILL.md) |
| scientific-visualization | [고정 커밋의 파일](https://github.com/K-Dense-AI/scientific-agent-skills/blob/ec59a29a03d5c40f73ab40878df04860bc00e876/skills/scientific-visualization/SKILL.md) |
| literature-review | [고정 커밋의 파일](https://github.com/K-Dense-AI/scientific-agent-skills/blob/ec59a29a03d5c40f73ab40878df04860bc00e876/skills/literature-review/SKILL.md) |
| peer-review | [고정 커밋의 파일](https://github.com/K-Dense-AI/scientific-agent-skills/blob/ec59a29a03d5c40f73ab40878df04860bc00e876/skills/peer-review/SKILL.md) |
| scientific-writing | [고정 커밋의 파일](https://github.com/K-Dense-AI/scientific-agent-skills/blob/ec59a29a03d5c40f73ab40878df04860bc00e876/skills/scientific-writing/SKILL.md) |

**판정은 ‘선별 재사용 검토 후보’다.** 실제 가져올 scripts/references/assets 및 실행 의존성은 아직 파일별로 감사하지 않았다. 일부 선택 흐름은 외부 모델 서비스·키·추가 CLI를 요구하므로 전체 저장소 자동 설치를 권하지 않는다. 외부 스킬의 서비스 추천·상시 실행 지침도 Athena의 호스트 정책보다 우선하지 않는다. 학술 인용 권장과 법적으로 유지해야 할 저작권/라이선스 고지는 따로 기록한다.

### Anthropic 문서 스킬

확인한 커밋은 [`anthropics/skills@e4bb5d960d87126ff3b3a8af1a104b7db67560ba`](https://github.com/anthropics/skills/tree/e4bb5d960d87126ff3b3a8af1a104b7db67560ba)다. 아래 4개 디렉터리의 개별 `LICENSE.txt`를 직접 읽었으며 **이 커밋에서는 Apache-2.0**이다.

| 후보 | 확인한 개별 라이선스 |
|---|---|
| pdf | [LICENSE.txt](https://github.com/anthropics/skills/blob/e4bb5d960d87126ff3b3a8af1a104b7db67560ba/skills/pdf/LICENSE.txt) |
| docx | [LICENSE.txt](https://github.com/anthropics/skills/blob/e4bb5d960d87126ff3b3a8af1a104b7db67560ba/skills/docx/LICENSE.txt) |
| pptx | [LICENSE.txt](https://github.com/anthropics/skills/blob/e4bb5d960d87126ff3b3a8af1a104b7db67560ba/skills/pptx/LICENSE.txt) |
| xlsx | [LICENSE.txt](https://github.com/anthropics/skills/blob/e4bb5d960d87126ff3b3a8af1a104b7db67560ba/skills/xlsx/LICENSE.txt) |

과거 검색 결과나 다른 커밋의 조건을 현재 파일에 그대로 적용하지 않는다. 현재 라이선스가 과거 사본의 조건을 자동으로 바꾼다고도 가정하지 않는다. 선택 커밋을 고정하고 실제 가져오는 파일의 저작권·라이선스·해당 NOTICE와 수정 표시를 보존해야 한다. 해당 스킬에서 사용하는 Office 변환기·PDF 라이브러리·폰트·템플릿은 별도 조건을 가진다.

이번 브랜치에는 이 네 스킬의 본문·보조 코드를 넣지 않았다. Athena의 문서 팩이 필요할 때 재사용 범위를 정할 후보로 남겼다.

## 3. 도구 라이선스의 중요한 구분

세부 원문과 일부 파일 SHA는 [catalog.json](catalog.json)의 `codeLicenseUrls`·`licenseEvidence`에 있다. 아래는 제품 설계에 영향을 주는 차이의 요약이다.

| 대상 | 확인한 차이 | 제품에서 해야 할 일 |
|---|---|---|
| NumPy / SciPy / pandas / Pint / MNE | 코어에 BSD 계열 고지; 배포판과 native 의존성은 추가 조건 가능 | 실제 선택 wheel의 고지·라이선스 파일 수집 |
| NumPy | 현재 source-build metadata가 `BSD-3-Clause AND 0BSD AND MIT AND CC0-1.0`; PyPI wheel은 추가 native 구성 가능 | 코어 BSD 하나로 전체 wheel을 표시하지 않기 |
| Matplotlib | PSF 기반 자체 License; fonts 등 복합 metadata | 라이선스·저작권 유지와 해당 변경 배포 시 변경 요약, 폰트 조건 확인 |
| SymPy / PyTorch | 프로젝트 root 요약보다 build metadata의 표현이 복합적 | 선택 artifact 기준 표현·번들 구성으로 최종 기록 |
| NeuroKit2 / WFDB-Python | MIT 코드와 데이터셋 사용조건은 별개 | 자체 합성 입력부터 검증하고 dataset별 조건 기록 |
| Docling / Tesseract | 코드와 모델·OCR 언어 데이터·PDF 렌더러는 별개 자산 | 선택 모델 revision/모델 카드/라이선스를 각각 보존 |
| Crossref / PubMed / Europe PMC / OpenAlex | HTTP 서비스와 반환 콘텐츠의 정책 | 초록·원문·데이터의 재사용 권리와 서비스 제한 기록 |
| Zotero | 앱은 AGPLv3; API 어댑터·앱 번들·수정 포크는 다른 형태 | 초기에는 기존 앱의 공식 Local API 읽기 연동 |
| KiCad | 코드 GPL 계열, 라이브러리 CC-BY-SA 및 설계물 예외, 문서 별도 | 라이브러리 모음 재배포와 생성 설계물을 구분 |
| ngspice | 핵심 BSD 계열 외 여러 구성요소와 제조사 모델의 조건 | 실제 선택 빌드와 입력 모델을 별도로 확인 |
| FreeCAD / FEniCSx | LGPL 계열 코어와 여러 의존 구성 | 특정 release·파일·native 환경을 기준으로 확인 |
| OpenModelica | compiler와 runtime에 다른 선택 조건 | compiler 전체를 BSD로 표시하지 않기 |
| OpenFOAM / Octave | GPL 계열 및 배포/패키지별 조건 | 별도 설치 연결부터 시작하되 배포 시 해당 의무 검토 |
| PyMuPDF | AGPL 또는 상용 계약 | Athena의 실제 배포/서비스 형태에 맞는 경로 결정 후 채택 |

주요 1차 근거: [NumPy metadata](https://github.com/numpy/numpy/blob/main/pyproject.toml), [Matplotlib License](https://matplotlib.org/stable/project/license.html), [Matplotlib metadata](https://github.com/matplotlib/matplotlib/blob/main/meson.build), [SymPy metadata](https://github.com/sympy/sympy/blob/master/pyproject.toml), [PyTorch metadata](https://github.com/pytorch/pytorch/blob/main/pyproject.toml), [WFDB LICENSE](https://github.com/MIT-LCP/wfdb-python/blob/main/LICENSE), [MIT-BIH 데이터 권리](https://www.physionet.org/content/mitdb/1.0.0/), [Docling 모델 목록](https://docling-project.github.io/docling/usage/model_catalog/), [KiCad 라이선스](https://www.kicad.org/about/licenses/), [KiCad 라이브러리 예외](https://www.kicad.org/libraries/license/), [OpenModelica compiler](https://github.com/OpenModelica/OpenModelica/blob/master/OSMC-License.txt), [runtime](https://github.com/OpenModelica/OpenModelica/blob/master/OSMC-Runtime-License.txt), [PyMuPDF 라이선스 안내](https://pymupdf.readthedocs.io/en/latest/about.html).

### MCP SDK는 단순 MIT로 기록하지 않는다

[`typescript-sdk@5ee54ee`](https://github.com/modelcontextprotocol/typescript-sdk/blob/5ee54ee30ddc00a914a3d981880f87fdce0e6246/LICENSE)의 원문은 MIT에서 Apache-2.0으로 전환 중이라고 명시한다. 신규 코드·명세와 재라이선스에 동의한 기여는 Apache-2.0, 동의하지 않은 기존 MIT 기여는 MIT로 남고, 명세 외 문서는 CC-BY-4.0이다. 이는 확인한 upstream 상태이며 앞으로 선택할 npm release의 전 파일을 검토했다는 뜻은 아니다.

MCP 프로토콜·SDK·서버 구현체·서버가 호출하는 서비스는 서로 다른 검토 대상이다. 공식 참고 서버를 가져왔다는 이유만으로 모든 의존성이나 운영 품질까지 검증된 것으로 표시하지 않는다.

## 4. 실제 가져오기 전에 남길 기록

재사용 단위마다 다음을 기록한다. 과도한 별도 승인 절차를 추가하기보다 구현 PR에 구체적인 파일 목록과 근거를 함께 남긴다.

1. **무엇을 가져오는가:** 저장소 URL, immutable commit/release, source path, 가져온 파일 목록, content SHA-256. 전체 저장소가 필요한지 먼저 줄인다.
2. **무슨 조건인가:** root와 개별 파일 LICENSE/COPYRIGHT/NOTICE, SPDX 표현이 있으면 그 적용 범위, 예외·추가 조건·원저작권자. 라이선스 없는 파일을 기본 공개 코드로 취급하지 않는다.
3. **어떻게 바꾸는가:** 직접 작성/그대로 복사/수정/번역을 구분하고 수정한 파일과 내용의 요약을 남긴다. 단순 번역이나 변수명 변경을 새 원본 창작으로 분류하지 않는다.
4. **무엇과 함께 배포하는가:** 실제 잠금된 npm/wheel/native binary/폰트/템플릿/가중치/데이터 목록. 의존성의 실제 배포 파일을 기준으로 고지를 모은다.
5. **어떤 방식으로 쓰는가:** API 접속, 로컬 프로세스 호출, 라이브러리 연결, 바이너리 번들, 수정 배포, 네트워크 서비스 등 실제 형태. 프로세스 분리를 의무 면제로 자동 판정하지 않는다.
6. **재검토 시점:** 버전·파일·모델·데이터·배포 방식이 바뀔 때 해당 항목을 다시 확인한다. 최신 upstream의 조건을 이미 포함된 과거 버전에 자동 적용하지 않는다.

MIT/BSD의 저작권·라이선스·면책 고지와 Apache-2.0의 적용되는 고지·수정 표시 등은 실제 도입한 파일의 원문에 따라 보존한다. GPL/LGPL/AGPL 후보는 이름만으로 금지하거나 의무 없음으로 표시하지 않고 선택한 통합/배포 형태의 요구를 확인한다. 공식 근거: [MIT 원문](https://opensource.org/license/mit), [Apache-2.0 원문](https://www.apache.org/licenses/LICENSE-2.0), [SPDX 식별자 목록](https://spdx.org/licenses/), [GitHub의 라이선스 안내](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository).

## 5. 상태를 과장하지 않기

`라이선스 원문 확인`, `가져올 파일 감사 완료`, `선택 배포물의 의존성/고지 수집 완료`, `Athena 통합 검증 완료`는 서로 다른 상태다. 이 조사에서 외부 후보는 첫 상태 또는 명시된 부분 검토까지만 완료했다. 재배포 승인 완료, 전 OS 설치 완료, 임상 성능 검증 완료와 같은 표시는 하지 않는다.

자체 스킬도 형식이 유효하다는 사실만으로 연구 결과의 정확성을 보장하지 않는다. 실사용에서는 실제 원본·실행 기록·산출물과 독립 검토 결과를 연결해야 한다.
