---
name: athena-plan-and-delegate
description: "Athena에서 연구 브리프를 작업으로 나누거나, 독립적인 분석을 서브에이전트에 위임하거나, 실행 중 작업의 추가 지시·대기·취소 계획을 세울 때 사용한다."
---

# 연구 계획과 위임

결론에 필요한 최소 작업만 계획하고 실제 TaskManager 도구로 위임하라.
이 절차로 새 scheduler·권한·미지원 tool을 만들어 냈다고 주장하지 마라.

## 입력

- 연구 질문, 완료 기준, 입력 파일 참조와 버전, 합의된 예산을 읽어라.
- 실제 parent/child 역할과 도구 registry·스키마·동시성/깊이 제한을 확인하라.
- 현재 run의 관측된 task·attempt·agent session ID와 상태를 확보하라.

## 계획

1. 결과가 서로 독립적인 작업만 병렬 후보로 나누어라.
2. 한 번의 읽기나 계산으로 끝나는 요청은 불필요하게 위임하지 마라.
3. 각 작업에 질문, 입력 근거, 필요한 도구, 산출물, 완료 검사를 명시하라.
4. 선행 결과가 필요한 작업은 그 결과를 확인한 뒤 다음 위임으로 계획하라.
5. M2에서 실제 DAG 편집 기능을 관측하지 않았다면 계획의 의존성을 저장된 그래프로 부르지 마라.
6. 작업 수와 자원 한도를 정하고, 결론에 기여하지 않는 세부 작업은 합쳐라.
7. 미지원 도구가 필요한 작업은 blocked proposal로 남기고 실행된 task와 구별하라.

## 위임과 제어

- 현재 M2는 parent에서 직속 child 한 단계만 지원함을 반영하라.
- child 기본 도구는 허용 입력 read와 고정 calculate_csv이며 재귀 spawn을 요구하지 마라.
- spawn_agent가 관측된 parent에서만 등록된 스키마로 호출하라.
- 파일 권한은 backend grant로 확인하라. 프롬프트의 파일 이름을 새 권한으로 해석하지 마라.
- 현재 입력 grant의 상속 범위를 확인하고, 프롬프트만으로 하위 권한을 격리했다고 주장하지 마라.
- 반환된 taskId·agentSessionId·attemptId를 기록하고 임의의 실행 ID를 만들지 마라.
- requestId 재전송은 같은 논리 요청에만 사용하고, 응답 불명 시 먼저 실제 상태를 조회하라.
- send_to_agent는 현재 M2에서 동일 child의 다음 turn을 추가하는 동작으로 설명하라.
- 추가 지시를 현재 실행의 즉시 변경으로 표시하지 마라.
- wait_for_agents로 합류하고 모델 슬롯 반환·재획득은 TaskManager에 맡겨라.
- 자체 잠금이나 반복 모델 호출로 기다리지 말고, UI 선택과 실행 소유권을 분리하라.
- 자식 취소는 등록된 cancel_task를, 전체 실행 취소는 호스트가 실제 제공한 경로를 사용하라. 관측하지 않은 cancel_run 모델 도구를 가정하지 말고 실제 종료 상태를 확인하라.
- 완료 응답, 실패, 취소, 재시작 중단을 각각 기록하라.

## 결과 통합

반환된 근거·artifact 참조를 확인하고 작업 간 모순을 드러내라.
failed 또는 interrupted child의 결과를 성공한 연구 근거로 조용히 합치지 마라.
run succeeded를 연구 주장 검증이나 독립 review 승인으로 바꾸지 마라.
현재 parent의 합류 후 종료 정책을 준수하고, 반복 재계획을 별도 capability 없이 약속하지 마라.

## 구조화된 출력

| 필드 | 기록할 내용 |
|---|---|
| objective | 이번 계획이 답할 질문 |
| proposed_tasks | 질문·입력·도구·완료 검사·의존성 |
| dispatched_tasks | 실제 반환 ID·관측 상태·입력 grant |
| control_actions | send/wait/cancel 요청과 확인된 결과 |
| evidence | artifact ID·버전·출처·검증 범위 |
| synthesis | 결론·모순·실패 영향·남은 제안 |

## 자체 예시와 인수 조건

두 조건의 CSV 기술통계를 비교할 때 독립적인 두 계산만 직속 child로 계획하라.
실제 두 Pi session ID, 각 입력 grant, 반환 artifact와 join 결과를 연결하라.
모델 동시성 한도가 1이면 직렬 실행을 허용하고, parent 대기로 child가 막히지 않는지 확인하라.
확인하지 않은 병렬 실행·취소·복구를 통과로 적지 말고, 관측된 결과만 인수 기록에 남겨라.
