# 백엔드 착수 전 계약 보완

현재 구현된 함수 이름과 추가 제안을 구분한다. 아래 항목은 백엔드가 임의의 성공 응답으로 덮어서 해결할 수 없다. 기준 UI는 이번 인계 작업에서 변경하지 않았다.

## G1. 실행 시작 소유자와 진입점 — M0/M1 필수

**현재:** app.js는 piSession.prompt로 채팅을 전송한다. AthenaTaskManager에는 getSnapshot/subscribe, 프로젝트·세션 수명주기, retry/cancel/approval 메서드만 있고 startRun/submitTask는 없다.

**결정:** Pi-compatible 호스트 요청을 TaskManager의 실행 접수로 통과시키는 단일 경로를 구현하거나, 별도 시작 계약을 UI와 함께 추가한다. 같은 prompt를 브리지와 scheduler가 중복 실행하지 않아야 한다. 실제 agent_start 전에 임의 running을 만들지 않는다.

**검증:** 같은 제출의 root run과 실행 소유권을 한 번만 만들고 중복 dispatch하지 않는다. 정상 agent loop의 도구 후속 턴·자동 재시도로 발생하는 여러 모델 호출은 같은 run에 기록한다. UI와 실행 로그에 같은 IDs가 남는다.

## G2. 문서 head와 과거 읽기의 구분 — 문서 영속화 전 필수

**현재:** ui/research-records.js의 loadDocument는 getDocument 결과를 acceptDocument에 넘긴다. dirty draft가 없는 경우 acceptDocument는 읽어 온 revision을 currentVersion으로 채택한다.

**확인된 동작:** fixture 문서 v2를 current로 둔 뒤 아직 캐시되지 않은 v1을 loadDocument로 읽으면 currentVersion도 v1이 된다. 이번 인계의 제한된 Node 재현에서 before=v2, after=v1, selected=v1이었다. [handoff-audit.json](handoff-audit.json)을 참고한다. 실제 서버 검증이나 기존 UI 수정은 수행하지 않았다.

**문제:** historical read가 서버 head를 뜻하는지 현재 응답으로 구분할 수 없다. 최신 편집 기준 및 expectedCurrentVersion 산정도 흔들릴 수 있다. 현재 저장 코드는 마지막으로 받아 보관한 host revision을 저장 전제조건으로 사용하므로 조회 순서를 서버 head로 간주하면 안 된다.

**추가 제안:**

- authoritative headVersion을 명시한다.
- head 조회와 historical 조회 의도를 구분한다.
- 서버 head, 화면 selectedVersion, 편집 draft.baseVersion을 별도 상태로 유지한다.
- 버전 목록 조회 계약을 정한다.
- historical 응답은 해당 버전을 캐시에 더하되 head를 바꾸지 않는다.
- 저장의 expectedCurrentVersion은 확인된 head에서 가져온다.

headVersion, read intent, 버전 목록 메서드는 **현행 API에 없는 확장 제안**이다. 서버가 새 wrapper를 반환하고 기존 UI가 알아서 읽는다고 가정하지 않는다. .d.ts, UI 수락 로직, backend response, 회귀 검사 변경을 함께 적용한다.

**검증:** v2가 head일 때 v1 조회·PDF export 후에도 head=v2이며, v1은 읽기 전용이다. v2에서 분기한 변경 저장은 서버 head에 대한 CAS로 검사된다.

## G3. 재접속 후 원본 bytes 복원 — Knowledge 영속화 전 필수

**현재:** Knowledge의 getOriginalFile(sourceId,version)은 현재 브라우저 메모리의 File만 조회한다. ResearchRecordService에는 listSources/storeSource/extractSource가 있고 원격 원본 다운로드 메서드는 없다. originalLocation은 저장 참조이며, 현재 원격 PDF를 자동으로 가져오는 코드가 아니다.

**결정:** 정확한 project/source/version으로 bytes를 읽는 계약과 Blob 생성 경로, 또는 인증된 다운로드 URL과 UI 로더를 추가한다. 방식과 메서드 이름은 아직 확정되지 않았다. 내부 URI와 사용 가능한 다운로드 주소를 분리할 수 있다.

**검증:** 원본 저장 후 UI와 호스트를 재시작하고 동일 버전 바이트의 해시가 일치한다. 다른 프로젝트나 새 버전에서 이전 File 객체를 재사용하지 않는다.

## G4. 검토 저장과 상태·근거 매핑 — 검토 기능 구현 전

**현재:** 문서의 document.reviewed 이벤트는 수신하지만 submitReview 등의 mutation은 없다.

| 객체 | 검토 상태 | Evidence |
| --- | --- | --- |
| TaskManager Artifact | unreviewed / in_review / approved / rejected | id, version |
| Research records | unreviewed / in_review / approved / changes_requested | sourceId, version, location? |

**결정:** reviewer 작업이 어느 서비스에서 검토를 기록하는지 정한다. 상태의 의미를 보존하는 매핑을 두거나 양쪽 타입을 함께 통합한다. 현재 서로 다른 객체를 그대로 공유해서는 안 된다.

**검증:** v1 승인 후 v2 작성 시 v2는 미검토다. 어떤 artifact/evidence 버전을 검토했는지 재조회할 수 있고, 이전 판정의 대상 버전이 바뀌지 않는다.

## G5. 연구 자료 이벤트 순서·목록의 의미 — 다중 작업자/재연결 전

**현재:** TaskManager에는 revision이 있으나 source.updated/document.saved에는 별도 sequence/head 계약이 없다. Knowledge는 반환된 목록을 merge하며 listSources에는 pagination이나 삭제 tombstone이 없다. 목록에서 빠졌다고 로컬 항목이 삭제되지 않는다.

**결정:** 최소 구현은 어댑터에서 프로젝트·자료별 순서를 보장하고 오래된 이벤트를 거른다. 확장 시 event sequence/head 또는 snapshot/cursor/deleted 표식을 합의하고 UI 수락 규칙을 같이 바꾼다. 현행 listSources에 임의 nextCursor를 넣어도 UI가 후속 페이지를 가져오지는 않는다.

**검증:** v2로 교체한 뒤 v1 추출 완료가 늦게 와도 head가 v1로 돌아가지 않는다. 재연결 이후 누락·중복·삭제 처리의 의미가 명확하다.

## G6. 브라우저 객체와 전송 계층 — M0/M1 필수

**현재:** SessionActivation.connection은 함수가 있는 객체이고, storeSource/stageFiles는 브라우저 File을 받는다. HTTP route나 IPC channel, 파일 바이트 전송 방식은 정의되어 있지 않다.

**결정:** 호스트 프록시를 구현한다. JSON에는 세션 metadata와 파일 metadata/실제 bytes 전송 참조를 싣고, UI 측 프록시가 실제 세션별 request/send/subscribe와 파일 전달을 제공한다. 임의의 HTTP 경로나 채널 이름을 이미 지원되는 API라고 쓰지 않는다.

ConnectionHost.getState는 현재 동기 반환을 사용한다. 비동기 초기 로드는 subscribe event 또는 동기 cache를 통해 반영한다.

**검증:** 프로세스를 나누어도 함수·File이 소실되지 않고, A의 프록시로 B의 prompt가 전송되지 않는다.

## G7. IDs, 재시도, 상태의 의미 — TaskManager 구현 전

**현재:** UI의 대화 ID와 Pi session ID equality gate가 있다. tool ID가 key이며 일부 Pi 활동 ID는 300 UTF-16 단위로 제한된다. 작업자 세션은 별도 공개 매핑 타입이 없다. 공개 TaskManager 상태에는 cancelling/unknown/attemptId가 없다.

**결정:** 부모 대화↔메인/작업자 Pi 세션, canonical tool ID↔원래 toolCallId를 저장한다. 짧고 충돌 없는 ID를 사용한다. retry attempt는 내부적으로 구분하고 UI 노출이 필요하면 타입을 확장한다. 미확인 종료·취소 대기 상태를 표현할 방법도 합의한다. 지원되지 않는 enum을 바로 보내면 기존 UI가 완전하게 처리한다고 가정하지 않는다.

**검증:** 두 작업자가 같은 raw toolCallId를 내도 기록이 덮이지 않는다. 실행 중 모델이 바뀌는 것으로 과거 run.model을 재작성하지 않는다. 취소 요청 접수와 실제 종료가 구분된다.

## G8. 영속 초안·출력 원문 조회 — 필요 범위 결정

**현재:** 초안·File 복구는 현재 UI 메모리 안에서 동작한다. 도구 상세 일부는 명시된 bounded preview이며 전체 출력 저장·조회 서비스는 없다. 파일 refs 저장과 Knowledge 원본 저장은 별도 호출이다.

**결정:** 영속 초안이 첫 릴리스 요구인지 정하고 필요하면 별도 저장·복원 계약을 추가한다. 전체 stdout/stderr·tool 결과는 호스트에서 보관하고 원문 조회를 제공한다. 같은 실제 원본을 두 경로에서 저장할 때 내부 blob을 공유할 수 있지만 project/source/version과 ref ID를 일관되게 매핑한다.

**검증:** “보존됨”의 범위가 세션 메모리인지 디스크인지 구분된다. preview에 없는 출력도 원문 서비스를 통해 누락 없이 읽을 수 있다.

## 진행 규칙

G1/G6/G7은 실행 호스트 골격을 정할 때 확정한다. G2/G3/G4/G5는 영속 자료·문서 작업을 시작하기 전에 UI 계약 변경과 함께 해결한다. G8은 릴리스 범위를 합의한다.

이번 패키지의 기존 테스트 통과 기록은 이 확장 기능이 완료됐음을 증명하지 않는다. 각 변경에 대한 실제 서비스 검사와 필요한 UI 회귀 검사를 추가한다.

