# Nurse Board

간호·보건 분야 채용 공고를 찾고 조건을 비교하고 저장하는 웹 서비스.

**현재 상태:** 웹 서비스 초기 운영

[서비스 열기](https://nurse-board-ten.vercel.app/) · [제품 설명](https://nodeoff.kr/products/nurse-board) · [소스 저장소](https://github.com/dhjin1125/nurse-board-web)

## 개발 환경에서 실행

Node.js 24 이상

```sh
npm ci
npm start
```

배포 빌드는 `npm run build`입니다. 환경 설정은 `.env.example`을 참고하세요. 운영 중인 채용 수집 데이터·사용자 저장 데이터는 저장소에 포함하지 않습니다. 외부 공고 제공처에 따라 검색 결과와 상세 정보가 달라질 수 있습니다.

## 운영자 정보

- 상호: 노드오프
- 대표: 진동현
- 사업자등록번호: 502-60-03676
- 운영 지역: 인천광역시
- 문의: [jin@nodeoff.kr](mailto:jin@nodeoff.kr)
- 회사 홈페이지: [nodeoff.kr](https://nodeoff.kr)

현재 개발 상태와 공개 주소는 회사 홈페이지와 함께 관리합니다.

## 공개 이력과 개발 경과

2026년 10월 7일 기존 비공개 작업을 정리해 처음 공개한 저장소입니다. 개발 시작일과 공개 커밋 날짜는 다릅니다. [개발 경과와 공개 범위](docs/development-history.md)를 확인해 주세요.

## Claude API 도입 계획

주력 서비스는 Nurse Board입니다. 현재 공개 기능은 공고 탐색·저장·지원 관리이며, Claude API는 아직 운영 연동 전입니다. 한국어 요청을 검색 조건으로 바꾸고 공고 원문에서 자격·근무 조건을 추출하는 기능을 계획하고 있습니다. 원문 근거와 없는 정보의 구분을 유지하고, 초기 사용자와 정확성·응답 시간·요청당 비용을 평가한 뒤 적용합니다. [현재 기능과 도입 계획](https://nodeoff.kr/products/nurse-board#claude-plan).

## Screenshot

![Public service screen](docs/screenshots/nurse-board-list.png)

Captured from the actual public website on 2026-10-07. This is a point-in-time view; sample UI illustrations on the company homepage are labeled as illustrations.
