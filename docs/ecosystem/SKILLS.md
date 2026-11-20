# Athena 자체 스킬과 외부 참고 후보

이 문서는 Athena의 연구 품질을 높이기 위해 직접 작성한 12개 스킬의 역할과 적용 순서를 안내한다. 세부 절차는 각 `SKILL.md`, 상태와 출처는 [catalog.json](catalog.json)을 기준으로 확인한다.

기준은 `yanaire/athena-1`의 M2 커밋 `d8a9241c790fdd9f2e88de5af5ab9429c2eaf9ea`이며, 조사일은 2026-11-20이다. 전체 범위는 [README](README.md), 연결 순서는 [IMPLEMENTATION](IMPLEMENTATION.md), 권리 검토는 [LICENSE-REVIEW](LICENSE-REVIEW.md)를 참고한다.

## 현재 제공한 것과 남은 것

- **자체 작성한 스킬 초안 12개**를 제공한다. 외부 스킬 본문을 복사하거나 개작한 묶음이 아니다.
- 12개 모두 `authored_draft_not_runtime_integrated`이며 `enabledByDefault: false`다. 기본 탑재 추천은 향후 제품 구성 제안이다.
- 스킬을 실제 Athena 런타임에 연결하거나 실제 모델로 통합 검증하지 않았다. 예시·인수 조건은 평가할 항목이며 통과 기록이 아니다.
- 이 묶음은 실행 스크립트·패키지·모델 가중치를 제공하거나 설치하지 않는다. 기능은 등록된 호스트 도구가 수행한다.
- 기준 M2에서 확인한 child 기본 도구 범위는 허용 파일 읽기와 고정 CSV 계산이다. HTTP 검색·PDF 추출·일반 분석·플로팅·문서 내보내기·Knowledge 버전 저장을 스킬 파일만으로 사용할 수는 없다.
- 기준 커밋에 Athena 루트 라이선스가 확인되지 않아 자체 초안의 배포 라이선스는 프로젝트 소유자의 정책 결정 대상으로 남긴다. 이 문서는 MIT·Apache 라이선스를 새로 부여하거나 기존 저장소를 재라이선스하지 않는다.

## 처음 자동 적용할 세 가지

첫 자동 활성화 대상은 **연구 요청 정리 → 출처와 근거 추적 → 데이터 품질 검사**의 기존 읽기 범위로 정한다. 새 도구를 추가하기 전에 요청·입력·확인 범위를 일관되게 기록하기 위한 우선순위다.

| 우선 대상 | 먼저 적용할 이유 | 첫 연결에서 확인할 결과 |
|---|---|---|
| `athena-research-intake` | 질문과 완료 기준을 정리해 불필요한 실행과 잘못된 비교를 줄인다. | 실제 입력 참조, 진행 가정, 실행 가능한 다음 단계가 있는 연구 브리프 |
| `athena-source-provenance` | 이미 제공된 파일부터 근거 위치와 접근·추출 상태를 분리할 수 있다. | 확인한 범위와 미확인 항목을 숨기지 않는 출처 기록 |
| `athena-data-quality` | 읽을 수 있는 CSV의 구조·결측 표기·관측 단위를 계산 전에 정리할 수 있다. | 실제 읽은 범위의 품질 관찰과 미실행 검사·정제 계획 |

12개 metadata는 등록하되 나머지 스킬의 명시 요청은 실제 capability에 맞춰 처리한다. 첫 세 스킬도 전체 파일 집계·PDF 추출·변환 도구가 지원되지 않으면 읽기로 확인한 내용과 미실행 항목을 구분한다.

**독립 검토는 다음 연결 우선순위**다. 실제 별도 검토 세션과 대상 입력·산출물 접근이 준비된 뒤 활성화 범위를 정한다. M2의 artifact 참조나 child 생성만으로 reviewer 접근·입력 격리가 보장되지는 않는다. 준비 전에는 근거 대조와 독립 검토 요청안을 구분하고, 같은 세션의 재점검을 독립 검토 완료로 표시하지 않는다. 긍정 판정도 저장·승인 권한을 부여하지 않는다.

## 자체 스킬 12개

아래 순서는 연구 작업의 흐름을 따른다. 모든 요청에 12개를 순차 실행하는 규칙은 아니다. 문헌 조사·계산·문서 작성 중 필요한 경로를 선택하고, 출처 추적과 검토를 해당 결과에 연결한다.

| 흐름 | 스킬 | 사용 시점·트리거 | 주요 산출물 | 절차 문서 |
|---|---|---|---|---|
| 요청 정리 | `athena-research-intake` | 새 연구 질문, 분석 의뢰, 모호한 목표 | 질문·입력·단위·제약·완료 기준을 담은 브리프 | [SKILL.md](../../skills/athena-research-intake/SKILL.md) |
| 계획·위임 | `athena-plan-and-delegate` | 작업 분해, 독립 분석 위임, 대기·취소 계획 | 의존성을 설명한 계획, 실제 child 참조·합류 상태 | [SKILL.md](../../skills/athena-plan-and-delegate/SKILL.md) |
| 문헌 탐색 | `athena-literature-search` | 논문 찾기, 선행연구 조사, DOI·서지 확인 | 실제 검색 이력·후보 표·초록/원문 범위·미확인 사항 | [SKILL.md](../../skills/athena-literature-search/SKILL.md) |
| 자료·출처 연결 | `athena-source-provenance` | 문서 수집·추출, 인용 근거 추적, 상충 자료 비교 | 원자료·추출물·주장 연결과 단계별 상태 | [SKILL.md](../../skills/athena-source-provenance/SKILL.md) |
| 단위 점검 | `athena-units-and-dimensions` | 단위 혼합, 센서 스케일, 식의 차원 확인 | 단위 사전·변환 기록·차원 검토·미확인 보정값 | [SKILL.md](../../skills/athena-units-and-dimensions/SKILL.md) |
| 입력 품질 점검 | `athena-data-quality` | CSV 분석·파일 결합 전, 결측·중복·누수 조사 | 확인 범위를 명시한 품질 결과와 정제 제안 | [SKILL.md](../../skills/athena-data-quality/SKILL.md) |
| 계산 실행·재현 | `athena-reproducible-computation` | 계산·시뮬레이션 실행, 재실행, 결과 차이 조사 | 입력·환경·설정·실제 실행·산출물 연결 기록 | [SKILL.md](../../skills/athena-reproducible-computation/SKILL.md) |
| 통계 해석 | `athena-statistical-analysis` | 조건 비교, 반복 측정, 효과·신뢰구간·예측 평가 | 표본 구조를 반영한 분석 계획·실행 결과·한계 | [SKILL.md](../../skills/athena-statistical-analysis/SKILL.md) |
| 시각화 | `athena-scientific-figure` | 연구용 그래프·논문 그림·캡션 요청 | 단위·오차·원자료를 연결한 설계 또는 실제 그림 | [SKILL.md](../../skills/athena-scientific-figure/SKILL.md) |
| 연구 글쓰기 | `athena-research-writing` | 보고서·논문 초안·방법·결과·고찰 작성과 수정 | 근거 연결 원고·변경 설명·남은 검토 | [SKILL.md](../../skills/athena-research-writing/SKILL.md) |
| 결과 검토 | `athena-independent-review` | 결론·계산 산출물·초안의 독립 대조 | 대상 버전을 지정한 판정·수정점·검토 범위 | [SKILL.md](../../skills/athena-independent-review/SKILL.md) |
| 지식 재사용 | `athena-knowledge-promotion` | 검토한 결과의 장기 저장·갱신 요청 | 적용 조건과 근거를 갖춘 승격 제안 또는 실제 저장 응답 | [SKILL.md](../../skills/athena-knowledge-promotion/SKILL.md) |

## 스킬과 호스트의 책임

스킬은 질문을 어떻게 정리하고, 어떤 근거를 확인하며, 결과를 어떻게 보고할지 안내한다. 실행 기능과 권한은 호스트 계약에서 확인한다.

- **작업 제어:** task·attempt·session·동시성·합류·취소·복구는 Athena TaskManager가 소유한다. 스킬이 자체 작업 큐나 두 번째 스케줄러를 만들지 않는다.
- **도구 접근:** 파일·네트워크·프로세스 권한은 등록된 도구와 backend 정책이 결정한다. 프롬프트나 스킬 문구가 권한을 추가하지 않는다.
- **품질 판단:** 실행 성공과 연구 주장의 지지 여부를 구분한다. 같은 코드를 다시 실행한 결과와 독립 검토도 구분한다.
- **지식 저장:** review 판정과 Knowledge 저장·승인은 별개다. 이미 유효한 사용자 지시와 backend 정책을 따르되 새 승인 체계를 스킬이 만들지 않는다.
- **미지원 기능:** 실행 가능한 부분은 계속하고 나머지는 계획·부분 결과·미확인으로 표시한다. 호출·파일·해시·버전·검토 완료를 만들어 내지 않는다.

## 외부 스킬 후보는 별도 출처로 관리

자체 12개는 Athena의 현재 도구 경계와 연구 흐름을 위해 작성한 절차다. 아래 10개는 추가 도입을 검토할 **외부 참고 후보**이며, 본문·스크립트·참고자료·에셋을 가져오거나 설치하지 않았다. 이름·관심 분야가 비슷하다는 이유로 자체 스킬의 출처나 라이선스로 적용하지 않는다.

### K-Dense 후보 6개

카탈로그는 `K-Dense-AI/scientific-agent-skills`의 커밋 `ec59a29a03d5c40f73ab40878df04860bc00e876`을 고정한다. 해당 [루트 LICENSE.md](https://github.com/K-Dense-AI/scientific-agent-skills/blob/ec59a29a03d5c40f73ab40878df04860bc00e876/LICENSE.md)와 선택한 스킬 헤더에서 MIT를 확인한 범위다. 전체 스크립트·참고자료·에셋·의존성까지 검토한 것은 아니다.

| 외부 후보 | 추가로 검토할 용도 |
|---|---|
| [scientific-critical-thinking](https://github.com/K-Dense-AI/scientific-agent-skills/blob/ec59a29a03d5c40f73ab40878df04860bc00e876/skills/scientific-critical-thinking/SKILL.md) | 주장·연구 설계·반론 검토 방법 |
| [statistical-analysis](https://github.com/K-Dense-AI/scientific-agent-skills/blob/ec59a29a03d5c40f73ab40878df04860bc00e876/skills/statistical-analysis/SKILL.md) | 통계 계획·가정·결과 보고 방법 |
| [scientific-visualization](https://github.com/K-Dense-AI/scientific-agent-skills/blob/ec59a29a03d5c40f73ab40878df04860bc00e876/skills/scientific-visualization/SKILL.md) | 과학 그래프 구성·표현 품질 |
| [literature-review](https://github.com/K-Dense-AI/scientific-agent-skills/blob/ec59a29a03d5c40f73ab40878df04860bc00e876/skills/literature-review/SKILL.md) | 문헌 탐색·선별·종합 방법 |
| [peer-review](https://github.com/K-Dense-AI/scientific-agent-skills/blob/ec59a29a03d5c40f73ab40878df04860bc00e876/skills/peer-review/SKILL.md) | 연구 산출물의 검토 관점 |
| [scientific-writing](https://github.com/K-Dense-AI/scientific-agent-skills/blob/ec59a29a03d5c40f73ab40878df04860bc00e876/skills/scientific-writing/SKILL.md) | 근거를 연결한 과학 글쓰기 |

### Anthropic 문서 후보 4개

카탈로그는 `anthropics/skills`의 커밋 `e4bb5d960d87126ff3b3a8af1a104b7db67560ba`을 고정한다. **이 커밋에서 선택한 네 문서 스킬은 각 LICENSE.txt 기준 Apache-2.0**으로 확인되어 있다. 다른 시점의 라이선스 설명을 이 고정본에 대신 적용하지 않는다. 실행 스크립트·포함 에셋·제3자 의존성의 전체 검토는 남아 있다.

| 외부 후보 | 추가로 검토할 용도 | 해당 스킬 라이선스 원문 |
|---|---|---|
| [pdf](https://github.com/anthropics/skills/blob/e4bb5d960d87126ff3b3a8af1a104b7db67560ba/skills/pdf/SKILL.md) | PDF 읽기·작성 작업 | [LICENSE.txt](https://github.com/anthropics/skills/blob/e4bb5d960d87126ff3b3a8af1a104b7db67560ba/skills/pdf/LICENSE.txt) |
| [docx](https://github.com/anthropics/skills/blob/e4bb5d960d87126ff3b3a8af1a104b7db67560ba/skills/docx/SKILL.md) | 워드 문서 구성·편집 | [LICENSE.txt](https://github.com/anthropics/skills/blob/e4bb5d960d87126ff3b3a8af1a104b7db67560ba/skills/docx/LICENSE.txt) |
| [pptx](https://github.com/anthropics/skills/blob/e4bb5d960d87126ff3b3a8af1a104b7db67560ba/skills/pptx/SKILL.md) | 발표 자료 구성·편집 | [LICENSE.txt](https://github.com/anthropics/skills/blob/e4bb5d960d87126ff3b3a8af1a104b7db67560ba/skills/pptx/LICENSE.txt) |
| [xlsx](https://github.com/anthropics/skills/blob/e4bb5d960d87126ff3b3a8af1a104b7db67560ba/skills/xlsx/SKILL.md) | 스프레드시트 처리 | [LICENSE.txt](https://github.com/anthropics/skills/blob/e4bb5d960d87126ff3b3a8af1a104b7db67560ba/skills/xlsx/LICENSE.txt) |

외부 후보의 고정 SHA·원문 경로·라이선스 근거·확인 범위는 [catalog.json](catalog.json)에 보존한다. 도입 시에는 실제 가져올 파일과 잠긴 의존성을 기준으로 필요한 고지·수정 기록·소스 제공 조건을 검토한다. 상위 저장소의 허용적 라이선스 확인을 전체 배포물의 검토 완료로 바꾸지 않는다. 세부 절차는 [LICENSE-REVIEW](LICENSE-REVIEW.md)를 따른다.

## 적용과 평가 순서

1. 12개 metadata와 선택 본문 로딩을 연결하고, 최초 자동 활성화는 research-intake/source-provenance/data-quality의 기존 읽기 범위로 제한한다. 선택된 스킬·버전을 기록한다.
2. 현재 읽기·고정 CSV 범위에서 요청 정리, 출처 연결, 데이터 품질 관찰과 실제 계산 결과를 확인한다. 지원되지 않는 작업이 성공으로 보고되지 않는지도 확인한다.
3. 독립 검토는 실제 세션·입력 grant·산출물 접근 준비를 확인한 뒤 평가한다. 분석·문헌·그림·문서 도구를 연결할 때도 해당 스킬의 인수 조건을 함께 평가하고 문법 검사와 실제 행동 평가를 분리한다.
4. 실제 산출물과 실행 근거를 모아 고정된 코드·스킬 버전으로 검토한다. 미실행·실패·부분 결과를 평가 기록에 남긴다.
5. Knowledge 도구가 준비되면 검토 결과·근거 버전·기존 권한을 연결해 저장을 검증한다. 그 전에는 승격 제안으로 남긴다.

구체적인 연결 작업과 인수 범위는 [IMPLEMENTATION](IMPLEMENTATION.md)에서 관리한다. 이 문서는 모든 스킬을 무조건 로딩하거나 외부 후보를 자동 설치하는 실행 명세가 아니다.

## 분야별 확장 후보

공통 12개가 실제 연구 흐름에서 작동한 뒤, 필요한 공학 분야를 선택 확장할 수 있다. 아래는 검토 방향이며 이번 묶음에 새 스킬 파일이나 실행 어댑터를 추가한 항목이 아니다.

| 확장 분야 | 자체 절차에 추가할 내용 | 실제 도구 연결 전 확인할 것 |
|---|---|---|
| 생체신호 | 채널·샘플링률·보정·필터·참가자별 분할·신호 품질 | 실제 입력 형식과 처리 라이브러리, 단위·전처리 이력 |
| 회로 | netlist·소자 모델·동작점·AC/과도 해석·기준값 비교 | 솔버 지원 범위, 모델 권리, 종료 상태·로그·파형 산출물 |
| PDE·연속체 해석 | 지배식·경계조건·재료값·격자·수렴·보존량 점검 | 선택 솔버와 라이선스, 자원·중단·복구 경로, 검증 예제 |

분야별 스킬도 TaskManager와 도구 계약을 그대로 사용하고, 해당 모델·데이터·솔버의 권리와 검증 범위를 별도로 기록한다.
