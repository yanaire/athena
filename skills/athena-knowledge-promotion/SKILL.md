---
name: athena-knowledge-promotion
description: "Athena에서 검토된 연구 결과를 장기 지식으로 남기거나, 재사용할 관찰·절차·주장을 Knowledge에 승격·갱신해 달라는 요청을 받았을 때 사용한다."
---

# 연구 지식 승격 제안

재사용 가능한 주장과 근거를 묶고, 실제 저장 권한과 버전 관리가 확인될 때만 승격하라.
이 skill과 reviewer의 긍정 판정은 저장·승인 권한을 새로 부여하지 않는다.

## 입력

- 후보 주장, 적용 조건, 단위, 산출물과 원시 근거의 실제 ID·버전을 수집하라.
- 실제 review 기록 또는 응답 내 verdict와 그 검토 대상을 구별하라.
- 이미 합의된 저장 범위·사용자 지시·backend 정책을 확인하라.
- Knowledge 조회·버전 저장·권한 판정 capability를 실제 registry에서 확인하라.

## 후보 정리

1. 관찰 결과, 해석적 주장, 재사용 절차를 구별하여 하나의 항목으로 정리하라.
2. 어떤 조건에서 유효한지와 적용하지 말아야 할 범위를 명시하라.
3. 주장마다 원시 입력·변환·계산·artifact·검토 기록을 연결하라.
4. 출처 URL이나 파일명만으로 검증됐다고 판단하지 말고 접근·검사 범위를 기록하라.
5. 작성자·모델·도구·버전·단위·불확실성과 미해결 반론을 보존하라.
6. 같은 주장이나 충돌하는 기록을 조회할 수 있으면 비교하고 중복·대체 관계를 제안하라.
7. 조회 capability가 없으면 중복 검사가 끝났다고 쓰지 마라.
8. 근거 부족·미검토·반박된 항목은 검토 필요 후보로 남겨라.

## 저장 판단

현재 M2의 Knowledge 영속 버전·승인 workflow가 통합됐다고 가정하지 마라.
기본 결과는 응답 내 promotion proposal이며, backend staged 상태가 저장됐다는 뜻이 아니다.
실제 저장 capability, 대상 버전과 이미 유효한 권한을 모두 확인한 경우에만 저장을 요청하라.
사용자가 이미 허용한 동일 범위의 승격에 불필요한 재확인을 요구하지 마라.
등록된 backend가 추가 결정을 요구하면 그 사유와 구체적 제안을 제시하라.
review verdict만으로 승인 receipt를 만들어 내거나 스스로 권한을 확장하지 마라.

## 버전과 복구

- 새 지식은 근거 버전과 함께 기록하고 기존 항목을 조용히 덮어쓰지 마라.
- 갱신 시 관측한 현재 버전과 backend의 충돌 검사를 사용하라.
- 중복 요청 방지는 등록된 멱등성 계약을 따르고, 불확실한 쓰기를 새 요청으로 반복하지 마라.
- 응답이 유실되면 실제 저장 결과를 조회하고, 조회 불가 시 outcome_unknown으로 남겨라.
- 저장 후 반환된 ID·버전·receipt를 재조회할 수 있으면 확인하라.
- 근거 변경·철회·새 반박이 생기면 재검토를 제안하고 기존 승인을 자동 승계하지 마라.

## 구조화된 출력

| 필드 | 기록할 내용 |
|---|---|
| mode | proposal_only / persisted / outcome_unknown |
| candidate | 주장·유형·적용 범위·한계 |
| evidence | 실제 입력·artifact ID·버전·변환·출처 |
| review | 검토 대상·verdict·실제 receipt 또는 null |
| authorization | 기존 사용자 지시·정책 근거·backend 확인 여부 |
| relation | new / duplicate_candidate / supersedes_candidate / conflict |
| proposed_change | 저장하거나 갱신할 구체적인 내용 |
| receipt | 실제 Knowledge ID·버전·저장 응답 또는 null |
| revalidation | 재검토를 유발하는 조건 |

## 자체 예시와 인수 조건

사용자가 두 CSV 분석의 결론을 “다음 연구에서도 쓰게 저장해 줘”라고 요청했다고 가정하라.
현재 backend에 영속 Knowledge 도구가 없으면 적용 조건·근거·review를 갖춘 proposal을 반환하라.
이 경우 mode는 proposal_only, receipt는 null이며 “승인되어 저장됐다”라고 쓰지 마라.
추후 실제 버전 저장 도구가 연결되면 같은 제안을 허용 범위 안에서 저장하고 반환 ID로 확인하라.
