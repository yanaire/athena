# Athena 모션 출처와 적용

## 현재 답변: Kokonut UI Agent steps

사용자가 지정한 적용 위치는 **답변 생성 표시**다. 현재 프로젝트는 React/Tailwind가 없는 HTML·CSS·JavaScript이므로 `shadcn`을 설치하지 않고 공식 `AI State Loading 2.0.0`을 기존 스택으로 옮겼다. 구현은 `motion/agent-steps.js/css`, 답변 연결은 `motion/reply.js/css`에 있다.

- [공식 문서](https://kokonutui.com/docs/ai/ai-loading)
- [검증한 원본 TSX](https://github.com/kokonut-labs/kokonutui/blob/655ec61161aff87721e4c60c3cc4dc3329f3e80e/components/kokonutui/ai-loading.tsx)
- 원본 Git blob: `a5fb5c74c7ab66e4d1d8885c0c382544a6fe2850`. Registry의 포함 코드와 별도 원본이 일치함을 확인했다.
- MIT © 2025 kokonutUI. 전체 고지를 `motion/LICENSE-KOKONUT.txt`와 구현 주석에 보존했다.

| 효과 | 원본과 같은 일반 모션 값 |
| --- | --- |
| 아이콘 교체 | opacity·blur 2px 전환 180ms |
| 진행 링 | linear 회전 800ms |
| 완료 체크 | 그리기 300ms + 50ms delay |
| 활성 단계 글자 | 1600ms ease-in-out, 글자당 50ms 지연, 중간 opacity 0.3 |
| 로그 | 높이 240ms, 위 이동 300ms, 새 줄 200ms; 줄 높이 24px, 최대 3줄 표시 |
| 완료 연결선 | scaleY 0→1, 500ms |
| 단계 목록 | 높이·opacity 250ms, 실제 완료 즉시 접기 시작 |
| 펼침 화살표 | 200ms |

명시된 공통 easing은 `cubic-bezier(0.23,1,0.32,1)`이다. 원본에 없는 spring이나 card bounce를 추가하지 않았다. 상태 아이콘은 기존 Lucide와 CSS 링으로, 색상·폰트·모서리는 Athena 스타일로 맞췄다.

답변에는 실제 관찰된 Waiting/Thinking/Replying만 최대 세 단계로 기록한다. 도구별 실행 줄은 기존 인라인 영역에 유지하며, 준비·실행·압축·재시도는 현재 헤더/상세 상태를 바꾼다. 같은 상태의 델타가 올 때 DOM과 애니메이션을 다시 만들지 않는다. 완료 요약은 눌러 다시 펼칠 수 있고, 오류·중단은 성공으로 접히지 않는다. 원본의 자동 데모 반복은 포함하지 않았으며 실제 상태는 SDK 이벤트로만 전환한다.

## Pi 활동과 답변 본문

현재 답변은 `Waiting`, `Thinking`, `Replying` 등의 실제 수신 상태에 따라 작은 아이콘과 회색 문구를 표시한다. 도구 입력 생성과 도구 실행을 별도 상태로 구분하고, 파일 읽기·쓰기·수정·검색·디렉터리·터미널 작업에 서로 다른 아이콘을 연결했다. 새 텍스트 청크는 240ms 동안 짧게 나타나고, 생성 중인 답변 끝에는 커서가 표시된다. 이미 표시된 전체 답변을 매번 다시 애니메이션하지 않는다.

활성 아이콘은 1.8초의 작은 호흡 효과, 상태 문구는 2.6초의 은은한 흐름, 재시도는 2.2초 회전을 사용한다. 완료·오류·중단 상태에서는 반복 효과를 제거한다. OS 또는 앱의 모션 줄이기 설정을 켜면 아이콘, 문구, 커서, 청크 효과를 멈추지만 라이브 스트림을 조기 완료하지 않는다. `start()`의 알려진 예시 답변만 즉시 표시할 수 있다. `begin()/append()/end()` 라이브 흐름은 실제 종료 이벤트를 기다린다.

예시 생성의 Waiting→Thinking 구간은 명시적으로 데모이며, Pi 이벤트 수신 시에는 도착한 이벤트로만 상태를 바꾼다. 일반 대화의 Pause/Stop 텍스트 도구줄은 제거했다. 입력창의 중단 아이콘은 예시 스트림을 중단하거나 연결된 세션의 abort를 요청하며, 실제 종료 이벤트가 오기 전 완료로 표시하지 않는다.

## DesignBookmark 디자인 참고 출처

[DesignBookmark Motion Studies](https://designbookmark.com/motion)의 Prompt Box, Mention Picker, Ghost Suggestion, Command Button, Morph Tooltip을 시각·인터랙션 참고 자료로 사용했다. 제작 경위는 제작자가 설명한 `Copy for Claude/Codex` 프롬프트를 통한 Athena UI 구현이다. 현재 사이트의 프롬프트는 원본 링크와 재구현 지시를 제공한다. 예전 프롬프트 전문은 확보하지 못했으며, 인계 소스에서 확인한 코드 중첩과 보관용 원본은 [UI 출처 감사](../../docs/ui-motion-provenance.md)에 따로 기록한다.

아래 Streaming Reply, Goo Thinking, AI Text Loading 행은 이전 버전의 출처 기록이다. 현재 답변에는 로드되지 않으며 나머지 입력창·메뉴·툴팁의 참고 동작과 값은 계속 적용된다.

2026-11-19. `k/c`=stiffness/damping. 공통 spring은 dt≤1/30초·4 substep, 단위질량(Command press만 0.6)을 유지했다.

| 구성·실제 출처 | Athena 위치 | 보존한 motion 값 |
|---|---|---|
| [Prompt Box](https://designbookmark.com/motion-src/prompt-box/prompt.js) | 하단 입력창 | 높이 420/34, 상태 380/30, 전송/중지 520/30 |
| [Mention Picker](https://designbookmark.com/motion-src/mention-picker/mention.js) | 입력창 `+` 통합 메뉴와 `@` 자료·플러그인·스킬 선택 | soft 260/24, fade 420/32, lead 620/36, trail 190/19, chip 520/16, 위치 900/50 |
| [Ghost Suggestion](https://designbookmark.com/motion-src/ghost-suggestion/ghost.js) | 입력 보완·Tab 수락 | key 520/24, opacity 300/30, hop 520/16; 제안 8ms/수락 16ms stagger, velocity −70 |
| [Streaming Reply](https://designbookmark.com/motion-src/streaming-reply/stream.js) | 후속 답변 본문 | 입장 300/22·0.75초, 크기 260/26, 단어 340/26; 준비 2.1초, stagger 70ms, y6px·blur4px |
| [Goo Thinking](https://designbookmark.com/motion-src/goo-thinking/think.js) | 답변 전 점 표시 | x 300/22, y 420/14, impulse −95; hop .3/.16/.46초; 합침 2.6초, scale 300/24→1.45, drop 300/26(+.45초), handoff +.6초, 폭 240/24 |
| [AI Text Loading](https://kokonutui.com/docs/ai/ai-text-loading) — 사용자 제공 v2 TSX | 답변 준비 상태 문구 | 교체 1500ms; wave 1.6초·간격70ms; 글자18ms stagger; 입장280ms/y8/blur4, 퇴장150ms/y−6/blur3; bezier(.23,1,.32,1) |
| [Command Button](https://designbookmark.com/motion-src/react/command-button.tsx) — 지정된 TSX 원본 | 입력창 도구줄·자료 찾기·⌘/Ctrl+K | press 520/34/mass .6, scale .97; 폭 300/28(bounce30); swap180ms+delay60ms, blur4, bezier(.23,1,.32,1) |
| [Morph Tooltip](https://designbookmark.com/motion-src/morph-tooltip/tooltip.js) | 패널·복사 등 아이콘 설명 | lead620/36, trail190/19, tail300/22, 표시420/24, label420/32, icon520/16; leave140ms |
| [AI Task List](https://smoothui.dev/r/ai-task-list.json) | 우측 워크플로우 | spring250ms/bounce.1, 완료 opacity.65/y1px; check·box200ms, check bezier(.23,1,.32,1); underline1.4초/bezier(.645,.045,.355,1), x0→200% |

공통 원본: [motion.js](https://designbookmark.com/motion-src/shared/motion.js), [tokens.css](https://designbookmark.com/motion-src/shared/tokens.css). AITextLoading은 사용자 제공 TSX, Command Button은 지정된 URL에서 읽은 TSX를 기준으로 구현했다.

## Athena 변경 범위

React·Motion UI를 plain DOM/CSS/rAF/WAAPI로 옮겼다. Task List의 spring은 `motion@14.14.0` generator에서 동일 설정으로 5ms 간격 51점을 샘플링했다. 나머지 k/c spring은 수치 적분한다. 반응형 폭, 따뜻한 색상, 영어 기본 문구, 시스템 글꼴과 한국어 입력 지원, 키보드·IME·포커스·정리 처리는 Athena에 맞췄다.

갤러리 자동재생·자동재시작·전역 테마/스토리지/부모 메시지와 계속 도는 페이지 루프는 제거했다. 작업 중 밑줄·wave는 해당 상태에서만 반복한다. 이전 Goo→Streaming Reply 연결은 현재 이벤트 기반 답변 모션으로 교체했다. `needs-confirmation`은 Task List에 추가한 정적 상태다. 입력·자료·연구 수치·서버 확인은 예시이며 실제 모델/도구 호출은 없다. Reduced motion은 이동·반복을 중단하거나 즉시 최종값으로 맞춘다.

## 라이선스와 검증 범위

- AITextLoading 제공본: **MIT**. [Kokonut 공식 LICENSE](https://github.com/kokonut-labs/kokonutui/blob/main/LICENSE) 원문을 `motion/LICENSE-KOKONUT.txt`에 보존했다(© 2025 kokonutUI).
- CommandButton 지정 원본: **MIT 표기**. 이 표기를 DesignBookmark 전체에 일반화하지 않는다.
- DesignBookmark plain 6개(Prompt/Mention/Ghost/Streaming/Goo/Tooltip): **라이선스 미확인**. 허용 범위를 추정하지 않았다.
- SmoothUI/Motion: MIT 고지는 `motion/LICENSE-SMOOTHUI.txt`, `motion/LICENSE-MOTION.txt`에 보존했다.

정적/DOM 검증·벡터 검토를 수행했다. 브라우저 모션·Figma 실행은 미검증이며 기존 접근 제한을 유지했다.

## 사이드 뷰 개선에서 유지한 모션

2026-11-19 추가 수정. + 메뉴로 항목과 배치를 확장했으며 soft/fade/lead/trail/chip/position의 기존 상수는 유지했다. 메뉴는 앱 루트에서 화면 경계에 맞춰 배치하고 스크롤한다. Morph Tooltip의 너비는 transform 영향을 받지 않는 offsetWidth로 측정한다. 패널 폭 조절은 사용자 포인터를 직접 따라가며 지연 애니메이션을 추가하지 않았다.

## 설정과 영어 기본 UI

2026-11-19 추가 수정. 자료 찾기는 검색 아이콘 하나로 접혀 있다가 입력창으로 확장된다. 기존 Command Button 스프링 값은 유지했다. UI, tooltip, aria 문구는 영어가 기본이며 한글 IME 보호와 내부 검색 별칭은 유지한다.

설정의 Reduce motion과 운영체제 prefers-reduced-motion을 함께 적용한다. 설정 변경 이벤트는 기존 JS spring과 CSS animation을 동기화한다. 모션을 줄일 때 알려진 데모 답변은 즉시 표시할 수 있지만, 외부 라이브 스트림은 이미 도착한 텍스트만 유지하고 계속 다음 이벤트를 기다린다. 일반 모션으로 돌아오면 원래 상수를 사용한다. Send key 설정은 전송 조합과 화면·접근성 안내를 함께 바꾼다.

## 서브에이전트 캐릭터

현재 버전은 ui/agent-avatars.js와 CSS의 작은 기하 도형을 사용한다. 실제 agent.id에서 도형·회전·은은한 색상을 결정하므로 상태가 갱신되어도 같은 에이전트의 표시가 유지된다. 표정, 눈깜빡임, 인사 및 반복 애니메이션은 제거했다. 실제 소환된 에이전트만 채팅 안에 표시하며, 도구 진행 내역은 테두리와 배경 없는 회색 문장으로 이어진다. Thinking과 개별 도구 줄을 펼치면 로그가 같은 자리에서 열린다. 펼침 전환은 설정 및 운영체제 reduced-motion을 따른다. 실행 예시는 Run demo 클릭 뒤에만 시작되고 일반 UI에서는 진행 상태만 보여 주며 테스트용 Pause/Resume/Stop API는 유지한다.
