# Athena 자체 스킬의 출처와 상태

작성일: 2026-11-20. 적용 범위는 이 디렉터리의 `athena-*/SKILL.md` 12개다.

## 작성 방식

사용자의 Athena 연구 하네스 요구와 M2 실행 구조를 바탕으로 한국어 절차를 새로 작성했다. 외부 SKILL.md 본문, 예시 코드, 이미지, 폰트, 템플릿, 보조 스크립트를 복사하거나 번역해 넣지 않았다. 작성 도구의 초기 안내 템플릿은 제거했으며, 파일에는 Athena용 frontmatter와 연구 절차가 있다.

기본 형식은 [Agent Skills specification](https://agentskills.io/specification)의 `SKILL.md` 구조를 참고한다. 형식을 따른다는 사실은 특정 호스트에 자동 설치됐거나 실행 권한이 부여됐다는 뜻이 아니다. 현재 Athena resource loader 연결은 별도 구현 대상이다.

## 포함한 스킬

| 스킬 | 파일 |
|---|---|
| 연구 요청 정리 | [athena-research-intake](athena-research-intake/SKILL.md) |
| 계획과 위임 | [athena-plan-and-delegate](athena-plan-and-delegate/SKILL.md) |
| 출처와 근거 추적 | [athena-source-provenance](athena-source-provenance/SKILL.md) |
| 단위와 차원 검사 | [athena-units-and-dimensions](athena-units-and-dimensions/SKILL.md) |
| 데이터 품질 검사 | [athena-data-quality](athena-data-quality/SKILL.md) |
| 재현 가능한 계산 | [athena-reproducible-computation](athena-reproducible-computation/SKILL.md) |
| 통계 분석 | [athena-statistical-analysis](athena-statistical-analysis/SKILL.md) |
| 과학 그래프 | [athena-scientific-figure](athena-scientific-figure/SKILL.md) |
| 문헌 조사 | [athena-literature-search](athena-literature-search/SKILL.md) |
| 연구 보고서 | [athena-research-writing](athena-research-writing/SKILL.md) |
| 독립 검토 | [athena-independent-review](athena-independent-review/SKILL.md) |
| 검토한 지식 저장 | [athena-knowledge-promotion](athena-knowledge-promotion/SKILL.md) |

## 라이선스 상태

기준 커밋 `d8a9241c790fdd9f2e88de5af5ab9429c2eaf9ea`에는 Athena 전체에 적용되는 root LICENSE를 찾지 못했다. 이번 변경은 프로젝트나 자체 스킬에 임의의 MIT/Apache 등 외부 배포 라이선스를 부여하지 않는다. 카탈로그에는 `project_owner_policy_pending_no_external_license_assumed`로 기록했다.

이 기록은 외부 스킬의 라이선스를 제거하거나 권리 조건을 우회하기 위한 것이 아니다. 향후 외부 파일을 가져올 때는 이 원본 작성 목록과 분리해 source commit·파일 경로·라이선스·수정 내용을 기록하고 필요한 고지를 보존한다. 공개/재배포 조건은 프로젝트 소유자의 정책에 맞게 명시한다.

## 사용과 검증 범위

12개 모두 `0.1.0` 초안이다. 각 스킬은 실제 capability와 근거를 확인하고 미지원 기능은 계획/부분 결과로 보고하도록 작성했다. 구조 검증·제한된 시나리오 검토와 Athena 호스트의 실제 스킬 선택·도구 실행·저장 검증을 구분한다. 해당 초안을 제품에서 사용하려면 [구현 문서](../docs/ecosystem/IMPLEMENTATION.md)에 따라 runtime에 연결해야 한다.

파일별 content SHA-256은 [catalog.json](../docs/ecosystem/catalog.json)에 기록한다. 이 hash는 초안의 파일 동일성을 위한 것이며 연구 입력/결과의 검증 hash와 혼동하지 않는다.
