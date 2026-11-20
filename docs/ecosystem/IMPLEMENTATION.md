# Athena 스킬·플러그인 구현 인계

관련 문서: [개요](README.md) · [스킬](SKILLS.md) · [플러그인](PLUGINS.md) · [라이선스 검토](LICENSE-REVIEW.md) · [조사 카탈로그](catalog.json)

## 1. 기준선과 변경 원칙

기준은 `yanaire/athena-1`, M2 commit `d8a9241c790fdd9f2e88de5af5ab9429c2eaf9ea`, 공식 Pi SDK `1.5.2`다.
현재 `runtime/pi.ts`의 고정 ResourceLoader는 skills/extensions를 빈 목록으로 반환한다.
현재 parent의 직속 child 위임·send·wait·cancel과 child의 허용 파일 read·고정 calculate_csv는 실제 구현이다.
범용 실행기, 일반 Python, MCP, 문헌 API, PDF 추출, 영속 Knowledge 승격은 현재 연결됐다고 취급하지 않는다.
이 문서는 구현 계획이다. 12개 SKILL.md는 작성된 절차이며 자동 선택·로딩·실행 검증이 완료된 기능이 아니다.
`catalog.json`은 `research-proposal-not-install-manifest`다. 이를 설치 명령이나 실행 권한으로 직접 해석하지 않는다.
Athena TaskManager가 task/attempt·스케줄링·terminal 상태를, 공식 Pi가 agent 실행을 계속 소유한다.
OmO는 구현 작업에 사용하는 도구이며 제품 의존성이 아니다. 새 Rust 코어·agent framework·중첩 scheduler를 만들지 않는다.

## 2. 작은 단계로 연결하기

| 단계 | 이번 단계의 산출물 | 다음 단계로 넘어갈 조건 |
|---|---|---|
| A: 첫 PR | 자체 스킬 12개 metadata registry, 선택 본문 로딩, capability에 맞는 실행/대체 안내 | 선택·hash·권한·실제 M2 경로를 구분해 검증 |
| B: 실행 기반 | 공통 process lifecycle + 별도 Python profile; 고정 CSV adapter 유지 | 실제 코드·환경·입출력·취소·재시작 근거 확보 |
| C: 자료 처리 | Crossref/PubMed/Europe PMC HTTP adapter와 pypdf 추출 | 검색·원문 접근·추출·근거 대조 상태 분리 |
| D: 분야별 선택팩 | 합성 자료를 쓰는 biosignal 또는 ngspice adapter부터 하나씩 | 실제 분야별 수치 인수 통과와 선택 환경 검증 |

A에서 12개 metadata를 등록하되 처음 자동 활성화할 절차는 `athena-research-intake`, `athena-source-provenance`, `athena-data-quality`의 기존 읽기 범위로 제한한다.
나머지도 명시 요청을 식별하되 필요한 capability가 없으면 가능한 정리·계획과 미실행 항목을 반환한다.
B는 uv/환경 lock과 NumPy·SciPy·pandas·Matplotlib·Pint 후보에서 실제 필요한 구성만 선택한다.
C는 인용·초록 API와 원문 사용 권한을 구별한다. PDF 파싱 성공을 검증된 Knowledge로 자동 승격하지 않는다.
D 이후 KiCad·FreeCAD·OpenModelica·FEniCSx·OpenFOAM을 분야별 선택팩으로 검토한다. MCP는 필요가 생길 때 별도 adapter로 추가한다.

## 3. 제안 인터페이스와 로딩 계약

아래 타입·필드·capability 이름은 설계 예시이며 현재 공개 API나 catalog schema가 아니다.
실행용 manifest는 검토된 자체 스킬에서 별도로 만들고, 조사 후보를 자동 import하지 않는다.

```ts
SkillDescriptor = {
  id, description, version, sourceCommit, relativePath, contentSha256,
  requestedCapabilities, allowedRoles, selectionPolicy
};
CapabilityDescriptor = {
  id, adapterId, adapterVersion, inputSchema, outputSchema,
  installed, configured, verification: { state, checkedAt, configDigest, environmentDigest },
  effects, supportedRoles, inputScope, limits, unavailableReason
};
SkillUseRecord = {
  projectId, sessionId, runId, taskId, attemptId,
  skillId, skillVersion, contentSha256, selectedBy, loadedAt, effectiveCapabilities
};
ExecutionSpec = {
  profileId, program, argv, cwdGrant, inputGrants, environmentRef,
  timeoutMs, memoryLimit, processLimit, outputByteLimit, expectedOutputs
};
```

시작할 때는 metadata만 모델의 선택 문맥에 제공하고, 선택된 본문만 필요한 turn에 읽어 hash를 확인한다.
12개 본문을 매번 system prompt에 붙이지 않는다. 명시 선택 또는 설명에 근거한 제한된 선택의 이유를 기록한다.
최초 본문 로딩 전 실제 ID·역할·capability를 대조하고, attempt마다 사용한 버전/hash를 고정한다.
파일 변경은 다음 선택부터 새 버전으로 처리하며 진행 중 attempt의 본문을 조용히 교체하지 않는다.
Pi 1.5.2의 실제 public ResourceLoader/custom-tool 경계를 확인하여 연결하고, 존재하지 않는 SDK 메서드를 가정하지 않는다.
`skill.load`, `python.execute`, `literature.search`, `document.extract` 같은 이름은 제안일 뿐이다. 등록 전 도구로 광고하지 않는다.

## 4. 권한·실행·증거

유효 권한은 host 정책 ∩ project 범위 ∩ task grant ∩ 역할 ∩ 도구 제약 ∩ 활성화 설정의 교집합으로 계산한다.
스킬은 필요한 기능을 요청할 수 있으나 권한을 늘리지 못한다. `allowed-tools` metadata는 OS sandbox가 아니다.
설치됨은 파일/실행파일 탐지, 설정됨은 경로·환경·credential 참조 구성, 검증됨은 해당 구성의 실제 인수 성공으로 구별한다.
버전·환경·설정이 바뀌면 검증 상태를 만료시킨다. credentials 값은 모델 문맥·로그·UI로 보내지 않는다.
스킬 본문과 외부 문서의 명령문으로 정책·grant를 우회하지 말고, 실행 시에도 host가 스키마·경로·입력 버전을 검사한다.
범용 runner는 명시적 program/argv와 환경 profile을 받고 shell 문자열·자동 package 설치를 기본 실행 경로로 삼지 않는다.
현재 CSV의 Node 전용 제한을 Python/외부 솔버의 격리 보장으로 재사용하지 않는다. OS별 실행 경계는 B에서 구현·검증한다.
모델 슬롯·세션 turn·process 자원을 구별하고 parent wait의 슬롯 반환은 기존 TaskManager에 맡긴다.
취소 요청 수락과 종료 확인을 구별하고 process group·timeout·출력 제한·남은 하위 프로세스를 처리한다.
재시작 후 불확실한 실행은 자동 재실행하지 않는다. 기존 attempt·receipt·종료 관측을 대조하고 불확실성을 보존한다.
입력 ID/버전/hash, 실제 코드·도구·환경, task/attempt/process ID, 종료 상태, 로그와 출력 hash를 연결한다.
출력 존재·스키마·단위·수치 검사와 reviewer verdict는 각각 기록하고 run succeeded를 과학적 승인으로 바꾸지 않는다.

## 5. Settings에서 보여 줄 항목

아래는 제안 UI 계약이다. 구현되지 않은 화면·저장 API를 이미 존재하는 기능으로 표시하지 않는다.

| 화면 | 필요한 필드와 동작 |
|---|---|
| Skills 목록 | 이름·설명·원본 위치·버전/hash·사용 설정·자동/명시 선택 범위·필요 capability·미지원 이유 |
| Skills 상세 | 실제 로딩 이력·연결된 task/attempt·본문 확인·이 버전을 사용한 이유; 활성화는 설치나 권한 부여가 아님 |
| Plugins 목록 | 설치됨/설정됨/검증됨을 별도 표시, 실제 버전·profile·마지막 검사·오류·선택팩 여부 |
| Plugins 상세 | 경로·환경·허용 입력/출력·네트워크 정책·자원 한도·credential 존재 여부·코드/모델 라이선스 출처 |
| 사용자 동작 | 검증 실행·설정 변경·사용 중지; 미설치 후보는 설치 안내만 제공하고 자동 설치하지 않음 |

첫 PR은 Skills의 최소 조회·선택 결과를 기존 UI 또는 개발용 조회 경로에서 확인할 수 있게 하라.
전체 Settings 재설계와 플러그인 marketplace는 후속 범위다. 미지원 기능은 버튼 성공 연출 대신 이유를 표시한다.

## 6. 첫 데모와 인수 경계

다음은 구현 후 수행할 목표이며 현재 스킬 로딩이 이미 검증됐다는 기록이 아니다.
기존 measurements CSV fixture를 사용하라: 데이터 5행, 숫자 7·13·21·35, 결측 1개, 값의 단위 mV.
요청은 “결측을 확인하고 평균을 계산한 뒤 근거와 검토할 점을 정리해 줘”로 고정한다.
선택된 읽기 절차의 version/hash를 기록하고, 기존 parent→child→calculate_csv→join 경로로 실제 결과를 얻는다.
기대값은 유효 count=4, missing=1, mean=19 mV다. 이 fixture는 표본 독립성·인과 효과·통계적 유의성을 입증하지 않는다.
원본 file ID/버전, 실제 task/attempt/process, statistics artifact·hash·로그를 연결하고 미실행 검사를 명시한다.
검토는 실제 근거 대조 결과와 독립 reviewer 요청안을 구별한다. 별도 reviewer 세션/입력 격리 기능이 없으면 독립 검토 완료로 표시하지 않는다.
독립 검토를 평가할 때 비공개 정답표·평가 라벨은 reviewer prompt나 상속 grant에 넣지 않는다.
별도 세션도 같은 모델을 쓰면 공통 편향이 남으므로 세션 분리와 모델 다양성을 동일시하지 않는다.
Knowledge는 proposal_only로 남긴다. 실제 버전·권한·저장 receipt가 없는 approved/persisted 상태를 만들지 않는다.

## 7. OmO에 붙여넣을 첫 PR 지시

```text
Athena의 첫 스킬 통합 PR 하나를 구현하라.
기준선은 M2 d8a9241c790fdd9f2e88de5af5ab9429c2eaf9ea이며 실제 현재 브랜치와 차이를 먼저 확인하라.
아래 문서와 자체 12개 SKILL.md를 읽고 기존 변경을 보존하라.
목표는 metadata registry + 선택 본문 로딩 + capability-aware fallback이다.
catalog.json은 조사 제안이며 install manifest나 권한 목록으로 사용하지 마라.
12개 자체 스킬의 name/description/path/version/hash를 별도 실행용 registry에 등록하라.
외부 skill·모델·패키지·바이너리를 자동 다운로드하거나 설치하지 마라.
모델에게는 metadata를 제공하고 선택된 본문만 로딩하라. 경로 범위와 hash를 검사하라.
최초 자동 활성화는 research-intake/source-provenance/data-quality의 기존 읽기 범위로 제한하라.
미지원 통계/Python/PDF/문헌/Knowledge 요청은 가능한 정리와 필요한 기능을 분리하여 응답하라.
사용한 skill version/hash와 선택 이유를 실제 task/attempt 기록에 연결하고 재조회 가능하게 하라.
실제 도구 registry·역할·입력 grant를 검사하고 skill 문구가 권한을 확대하지 못하게 하라.
공식 Pi SDK 1.5.2의 public 경계로 연결하라. 필요한 변경 위치와 실제 SDK 호출을 설명하라.
Athena TaskManager의 scheduler·wait 슬롯·취소·terminal 소유권을 유지하라.
현재 고정 CSV jobs와 read는 유지하고 범용 runner·Python·MCP·새 agent framework를 이 PR에 추가하지 마라.
Skills 선택/미지원 이유/사용 이력을 확인할 최소 조회 경로를 제공하고 전체 UI 재설계는 하지 마라.
측정 CSV 5행·1결측·숫자 7,13,21,35의 mean=19 mV 경로로 실제 SDK/도구 연결을 검사하라.
근거와 검토 요청안을 반환하되 독립 reviewer 또는 Knowledge 저장이 구현됐다고 주장하지 마라.
추가 인수: 12개 metadata와 선택 본문의 일치, 선택 안 된 본문의 prompt 미포함, hash 변조 거부.
추가 인수: 미지원 PDF/일반 Python 요청에 도구 호출·가짜 artifact·실행 ID가 생기지 않음.
추가 인수: 재시작 후 사용한 skill version/hash와 실제 작업 연결을 조회할 수 있음.
현재 M2의 위임·대기·취소에 영향을 주는 변경만 관련 회귀로 확인하고 M1 전체 재인수로 확대하지 마라.
모델 응답 fixture, 실제 SDK/CSV 실행, 실모델 검증을 구별하고 미실행 항목을 보고하라.
완료 보고에는 변경 파일·registry/API 계약·실제 검증 근거·남은 capability를 포함하라.
라이선스 결정은 LICENSE-REVIEW.md를 따르고 root LICENSE를 새로 만들지 마라.
```

일반 실행/Python profile과 선택 adapter는 이 PR의 인수 이후 별도 작업으로 진행한다.
