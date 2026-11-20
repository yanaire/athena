# Athena backend — 먼저 읽기

## 개발 요청

이 폴더의 기존 Athena UI를 유지하고 실제 백엔드를 구현해 주세요.

기존 UI에는 채팅·모델 선택·추론 수준·인라인 에이전트/도구 실행·Workflow·Artifacts·Knowledge·Manuscript·설정·패널 크기 조절이 있습니다. 먼저 코드를 읽고 이 컴포넌트와 연결 지점을 재사용해 주세요.

### 먼저 할 일

1. [athena-backend-handoff.md](athena-backend-handoff.md), [CONTRACT-GAPS.md](CONTRACT-GAPS.md), integrations/*.d.ts를 읽고 구현 계획을 정합니다.
2. TypeScript 호스트를 기본 착수안으로 검토하고, 사용할 Pi SDK 버전을 명시해 lockfile을 만듭니다. 실제 설치 SDK와 타입 계약을 컴파일합니다.
3. 로컬 프로세스/데스크톱 셸과 UI 사이의 전송 방식, 자격 증명 소유자, 데이터 저장 위치를 정합니다.
4. 현재 UI의 prompt 경로를 TaskManager 실행 접수와 연결합니다. 현재 TaskManager 계약에 startRun 메서드가 존재한다고 가정하지 마세요.
5. M1 경로를 실제로 동작시키고 나서 서브에이전트·실행 제어·영속 자료/문서를 확장합니다.

### 첫 납품 범위

**실제 모델 1개 + 실제 프로젝트/대화 1개 + 실제 파일 읽기 도구 1개 + 답변 스트리밍 + 기록 저장/재조회.**

- 실제 프로젝트와 대화를 만들고 ID를 받습니다.
- 현재 대화와 Pi session ID가 일치한 상태에서 prompt를 보냅니다.
- 실제 파일 읽기 동작과 로그를 표시합니다.
- 실제 답변을 스트리밍하고 완료 상태를 확인합니다.
- 앱/호스트를 다시 열어 같은 대화의 기록을 조회합니다.
- 실패한 연결·읽기·저장은 실패로 표시합니다.
- 샘플 RC 데이터나 데모 타이머로 실제 결과를 대체하지 않습니다.

### 그다음 구현

- TaskManager: 의존 작업, 실제 worker Pi 세션, 동시 실행, 승인, 취소, 재시도, 복구
- ConnectionHost: 저장·실제 연결 확인·세션 생성, 네 모델 범위
- FileService: 실제 업로드/저장, 참조 해석, 원격 원본 복원
- ResearchRecordService: Knowledge, 추출, 문서 head/history, 충돌 검사, 버전별 검토, PDF 내보내기
- 실제 브라우저 접근성·작은 창·키보드·모션 검사

과거 문서를 읽었을 때 local currentVersion이 바뀌는 확인된 동작, 원격 원본 조회 API 부재, 검토·evidence 형식 차이는 CONTRACT-GAPS에 있습니다. 해당 범위는 UI와 타입 계약도 함께 보완해야 합니다.

### 유지할 제품 동작

- 기본 영어 UI, 기존 색상·폰트·모서리, 아이콘과 패널 구조
- 한 개의 오른쪽 side view toggle, 접기/펼치기·폭 조절
- 채팅 안의 geometric agent 표시와 조용한 tool activity
- 기존 모델 picker의 검색·오류 처리·지원 reasoning 검사
- 원문/첨부 보존, 버전별 근거·검토 분리, 미연결 상태의 정직한 표시

### 보고 방법

완료 시 실제 연결한 기능, 사용 버전과 실행 명령, IDs가 연결된 로그, 저장 후 재조회 증거, 직접 본 화면, fixture로만 확인한 항목, 미구현/미확인 항목을 구분해 주세요.

## 기존 UI 확인 명령

아래 명령은 **전달된 UI와 fixture 검사**를 실행합니다. 백엔드 서버를 시작하는 명령이 아닙니다.

```sh
cd athena-codex-ui
python3 build.py
cd qa
npm ci
npm test
node --test pi-host-adapter-test.mjs runtime-integrity-test.cjs workspace-session-test.cjs connection-manager-test.cjs research-records-test.cjs workspace-views-test.cjs
```

빌드한 athena-preview.html은 브라우저에서 열어 UI를 확인할 수 있습니다. 기존 보고서의 재현 환경은 Node v24.22.3, LinkeDOM 0.18.15입니다. 이는 최소 지원 버전이나 백엔드의 실행 환경을 확정한 값이 아닙니다.

일부 테스트는 과거 작업 공간 fallback 경로를 갖고 있으므로 반드시 qa 폴더에서 npm ci를 실행해 로컬 개발 의존성을 설치합니다. 공식 전달 대상은 standalone HTML입니다. build.py의 --inline 옵션은 이번 기준 버전의 납품·검증 대상이 아닙니다.

## 패키지 구분

- **athena-codex-ui/**: 이전 소스 ZIP의 원본 120개 파일
- **athena-backend-handoff.md**: 전체 인계서
- **CONTRACT-GAPS.md**: 선행 계약 보완
- **ACCEPTANCE.md**: 실제 서비스 완료 판정
- **SDK-SOURCES.md**: 버전·공식 자료 확인 범위
- **BASELINE.json**: 기준선과 파일 해시
- **handoff-audit.json**: 새로 확인한 head/history 문제의 제한된 재현 기록

이 패키지에는 새 서버 구현, 실제 API 키, 실행 중인 모델 서비스가 들어 있지 않습니다.

