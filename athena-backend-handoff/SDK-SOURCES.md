# Pi SDK — 출처와 버전 확인 범위

확인일: 2026-11-20

이 문서는 전달 코드의 목표 버전과 이번 인계에서 확인한 공식 자료를 구분한다. SDK 설치·실행·TypeScript 컴파일 성공을 보증하는 문서가 아니다.

## 1. 전달 코드에 기재된 기준

- 패키지: `@earendil-works/pi-coding-agent`
- 버전: `1.5.2`
- 코드에 기재된 commit: `653f332b6fe22e2e927dd3d553d20234a3de27f0`
- 근거: [PI-CAPABILITIES.md](athena-codex-ui/docs/PI-CAPABILITIES.md), [PI-HOST-ADAPTER.md](athena-codex-ui/docs/PI-HOST-ADAPTER.md), [어댑터 주석](athena-codex-ui/integrations/pi-host-adapter.mjs)

위 정보는 **기존 소스가 선언한 목표**다. 이번 작업에서는 해당 commit의 모든 원본을 다시 받아 확인하거나 실제 npm 패키지와 동일성을 검사하지 않았다.

이번에 열어 본 공식 [releases 페이지](https://github.com/earendil-works/pi/releases)는 v1.5.2 항목에 축약 commit `b4afddd`를 표시했다. 기존 코드의 위 SHA와 같은 값이라고 쓰지 않는다. 릴리스 태그, npm 배포물, 기존 어댑터 기준 소스의 관계는 구현 시작 시 확인해야 한다.

## 2. 이번에 직접 읽은 공식 자료

아래 main 링크는 고정 commit 링크가 아니므로 나중에 내용이 바뀔 수 있다. 최종 구현은 선택한 설치 패키지와 고정 소스에 맞춘다.

| 자료 | 확인한 내용과 구현상 의미 |
| --- | --- |
| [SDK 문서](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md) | Node.js/Bun 내 임베딩, createAgentSession으로 세션 생성, prompt/subscribe, 세션 교체 시 구독 재연결을 설명한다. message_end와 agent_settled의 의미를 구분한다. SDK에서 CLI 확장 기능이 모두 자동 활성화된다고 가정하지 않는다. |
| [AgentSessionRuntime 원본](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/agent-session-runtime.ts) | 현재 factory는 runtime 생성 함수와 초기 target options를 받는다. 단순히 createAgentSessionRuntime({cwd})로 호출한다고 가정하지 않는다. |
| [공식 subagent 확장 예제](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/subagent/index.ts) | 별도 Pi 프로세스를 이용하는 단일·병렬·연쇄 예제다. Athena의 작업 그래프·저장·취소 계약이 이미 구현된 것이라는 뜻은 아니다. |
| [Releases](https://github.com/earendil-works/pi/releases) | 릴리스 표기와 선택 버전을 대조할 출처다. 설치 패키지의 타입·동작 검사를 대신하지 않는다. |

자료를 읽은 범위를 넘어 실제 provider·subprocess·스토리지 연동을 검증했다고 표현하지 않는다. 어댑터의 현재 세부 기능 목록은 기존 PI-CAPABILITIES 문서와 구현 파일을 같이 읽는다.

## 3. M0에서 개발자가 확정할 사항

1. 사용할 정확한 SDK 버전을 설치하고 lockfile을 커밋한다. 버전·resolved package·integrity를 기록한다.
2. 실제 SDK export와 현재 어댑터가 기대하는 session/runtime/model/resource API를 컴파일·실행으로 대조한다.
3. createAgentSession의 결과 객체와 AgentSessionRuntime을 구분한다. 세션 lifecycle이 필요한 경우 그 버전의 공식 runtime 예제를 기준으로 호스트를 구성한다.
4. 최초 세션과 교체 세션의 extension binding 및 이벤트 구독을 연결한다. 기존 rebind hook을 덮어쓰지 않고 소유자를 명시한다.
5. prompt가 started/queued/handled로 분기하는 실제 결과와 최종 settled를 각각 검증한다. 호스트 어댑터의 조기 ack를 생성 완료로 취급하지 않는다.
6. 실제 사용할 도구·skills·extensions·MCP를 명시적으로 구성하고 capabilities가 실제 지원과 일치하는지 확인한다.
7. 실제 인증 정보는 호스트에 설정한다. 이 전달물에 없는 키나 endpoint를 가정해 성공 상태를 생성하지 않는다.

새 SDK를 선택하면 기존 어댑터를 그대로 호환된다고 선언하지 말고 차이와 수정 파일을 납품 보고에 기록한다.
