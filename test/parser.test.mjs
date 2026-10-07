import test from 'node:test';import assert from 'node:assert/strict';import {once} from 'node:events';import {app,jobDetailService,extractOfficialRecruiterUrl,parseOfficialNoticeText,parseOfficialRecruiterAssets,parseNurseJob,parseNurseDetail,parseHallymDetail,parseGenericJobDetail,parseWantedDetail,parseSaramin,parseJobKorea,parseCatch,parseWork24,parseAlio,parseNurseLink,parseKaohn,parseKisanhyup,parseSnuh,parseAmc,parseSamsung,parseMedicalJob,parseHospitalJob,parseCaseManager,parseEumc,parseKumc,parseKhmc,parseKuh,parseCmc,parseRecruiter,parseRnjob,parseWantedPositions} from '../server.mjs';
import {SOURCES} from '../src/sources.js';

test.beforeEach((t) => {
  const refresh = jobDetailService.refresh;
  t.mock.method(jobDetailService, 'refresh', (job) => refresh(job, { persistResult: false }));
});

const HALLYM_DETAIL_URL = 'https://recruit.hallym.or.kr/hrt_p20_detail.jsp?locate=7&adoptcnt=169&inggbn=ing&adoptyy=2026&innlist=1';
const hallymDetailFixture = () => `<div class="career_detail"><div class="tit">한림대학교성심병원 간호부 정규직 전담간호사 공개채용 공고</div><div class="context">
  <div id="gesi">게시일 : 2026.08.31 조회수 : 1971</div>
  <p>1. 모집 분야 및 응시자격</p>
  <table><tr><td>직종</td><td>진료과</td><td>분야</td><td><p>채용</p><p>인원</p></td><td>응시자격</td></tr>
  <tr><td rowspan="2">간호사</td><td>응급의학과</td><td>응급실</td><td>0명</td><td rowspan="2"><p>* 경력 관련 필수자격</p><p>(아래 중 하나의 요건을 갖추어야 함)</p><p>1) 병원 및 종합병원, 군병원에서 임상경력</p><p>36개월 이상인 자</p><p>(단, 전체 임상경력 중 진료지원업무 경력 18개월 이상 반드시 포함)</p><p>2) 전문간호사</p><p>* 기타 필수 응시자격</p><p>1) 최종합격 후 즉시 근무 가능한 자</p></td></tr>
  <tr><td>신경외과</td><td>병동/수술</td><td>0명</td></tr></table>
  <p>※ 모집형태 : 정규직</p><p>※ 근무형태 : 1) 3교대</p><p>2) 주근제 : 주말근무 및 당직 발생 가능</p><p>※ 자기소개서에 지원 진료과 기입</p>
  <p>2. 전형일정</p><p>1) 접수기간 : 2026.07.30(목) ~ 채용시까지</p><p>2) 접수방법 : 채용사이트를 통한 온라인 접수</p><p>3) 서류전형 합격자 발표 : 개별 연락</p><p>4) 면접 전형 : 개별 면접</p>
  <p>3. 제출서류</p><p>1) 졸업증명서 1부</p><p>2) 간호사면허증 1부</p>
  <p>4. 기타사항</p><p>- 급여는 본원 내규에 따름.</p><p>- 국가보훈대상자는 관계법령에 의거 우대함.</p>
  <p>5. 개인정보 보관기간</p><p>- 개인정보는 채용 확정 이후 6개월 이내 파기</p><p>- 문의처 : hallymnurse@hallym.or.kr, 031)380-4021</p>
</div></div>`;
test('parses a public NurseJob card',()=>{const html=`<div class="nurse_box"><div class="basic_box"><a href="/recruit/recruit_view.php?r_idx=123"><ul class="b_t_company">테스트병원</ul><ul class="b_t_subject">병동 간호사 모집</ul></a><ul class="b_i_area"><li>서울</li></ul><ul class="b_i_time"><li>D-3</li></ul></div></div>`;assert.equal(parseNurseJob(html)[0].id,'nursejob-123')});
test('parses NurseJob table row registration date and backfills box jobs',()=>{const html=`<div class="nurse_box"><div class="basic_box"><a href="/recruit/recruit_view.php?r_idx=123"><ul class="b_t_company">테스트병원</ul><ul class="b_t_subject">병동 간호사 모집</ul></a><ul class="b_i_area"><li>서울</li></ul></div></div><table class="info_table"><tr id="l_123"><td class="left"><p class="name">테스트병원</p></td><td class="left"><p class="title">병동 간호사 모집</p><p class="stxt">서울 성동구</p></td><td class="date">3분전 등록<br/>10-01 (목)<li>D-4</li></td></tr><tr id="l_456"><td class="left"><p class="name">다른병원</p></td><td class="left"><p class="title">외래 간호사</p><p class="stxt">경기 성남시</p></td><td class="date">2시간전 등록<br/>채용시</td></tr></table>`;const jobs=parseNurseJob(html);assert.equal(jobs.length,2);assert.equal(jobs[0].publishedAt,'3분전');assert.equal(jobs[1].publishedAt,'2시간전');assert.equal(jobs[1].deadline,'채용시')});
test('parses a rich Saramin health manager result',()=>{const html=`<div class="item_recruit" value="99"><div class="area_badge"><span class="badge">인기 공고</span></div><h2 class="job_tit"><a href="/job/99">산업간호사 보건관리자</a></h2><div class="job_condition"><span><a>경기</a></span><span>경력무관</span><span>초대졸↑</span><span>정규직</span></div><div class="job_date"><span class="date">~ 07/21(화)</span></div><div class="job_sector"><a>보건관리자</a><span class="job_day">수정일 26/07/08</span></div><strong class="corp_name"><a>테스트기업</a></strong></div>`;const job=parseSaramin(html)[0];assert.equal(job.employment,'정규직');assert.equal(job.education,'초대졸↑');assert.deepEqual(job.sectors,['보건관리자'])});
test('parses NurseJob structured detail',()=>{const html=`<script type="application/ld+json">{"@type":"JobPosting","employmentType":"정규직","experienceRequirements":"경력3년","educationRequirements":"학력무관","qualifications":"간호사 면허","workHours":"주5일"}</script><dd><span class="tit">담당업무</span>채혈 및 외래 업무</dd><dl class="newwelfare_list"><div class="con">중식 제공</div></dl>`;const detail=parseNurseDetail(html);assert.equal(detail.duties,'채혈 및 외래 업무');assert.equal(detail.qualifications,'간호사 면허');assert.deepEqual(detail.welfare,['중식 제공'])});
test('parses the linked Hallym notice into complete readable sections',()=>{const detail=parseHallymDetail(hallymDetailFixture(),HALLYM_DETAIL_URL);assert.equal(detail.publishedAt,'2026-08-31');assert.equal(detail.department,'복수 진료과(2개 분야)');assert.equal(detail.workPattern,'3교대·주근제(부서별)');assert.match(detail.experience,/임상경력 36개월 이상/);assert.match(detail.experience,/진료지원업무 18개월 이상/);assert.equal(detail.deadlineText,'2026.07.30(목) ~ 채용시까지');assert.equal(detail.salary,'병원 내규에 따름');assert.deepEqual(detail.sections.map(({title})=>title),['모집 분야','자격요건','근무조건','전형일정','제출서류','지원방법','지원서 작성 유의사항','기타사항','개인정보·중복지원 안내','문의처']);assert.match(detail.sections[0].value,/응급의학과 · 응급실/);assert.match(detail.sections[0].value,/신경외과 · 병동\/수술/);assert.match(detail.sections.find(({title})=>title==='제출서류').value,/간호사면허증/);assert.match(detail.applicationMethod,/공식 채용공고/);assert.equal(detail.officialUrl,HALLYM_DETAIL_URL)});
test('parses a numbered official hospital notice into decision-ready sections',()=>{const text=`국립암센터 정규직 간호직(경력직) 채용공고
1. 채용분야별 채용인원
간호직 6급 1명
□IRB 지원 업무
○IRB 표준작업지침서 유지·관리
2. 지원자격
- 간호사 면허증 소지자
- 임상연구보호프로그램(HRPP) 관련 업무 경력 1년 이상
3. 급여
간호직 약 37,202천원
※ 복리후생
- 복지 포인트 지급
4. 전형절차
서류전형
조직적합성 검사
면접전형
5. 지원서 접수 : ‘26.08.20.(목) ~ 09.04.(금) 17:00
온라인 접수
6. 우대사항
장애인 가산
10. 기 타
○ 최초 임용계약은 1년이며, 재계약 임용 심사를 통과하는 경우 임용 기간은 정년까지임`;const detail=parseOfficialNoticeText(text);assert.match(detail.duties,/IRB 표준작업지침서/);assert.match(detail.qualifications,/간호사 면허증/);assert.equal(detail.experience,'임상연구보호프로그램(HRPP) 관련 업무 경력 1년 이상');assert.equal(detail.salary,'연봉 약 37,202천원');assert.equal(detail.headcount,'1명');assert.match(detail.deadlineText,/17:00/);assert.equal(detail.employment,'정규직');assert.deepEqual(detail.sections.map(({title})=>title),['공고 개요','채용 직무·인원','지원자격','급여·복지','전형절차','접수 기간·방법','우대사항','고용 안정성·기타 안내'])});
test('finds a linked Recruiter notice and keeps only same-host official assets',()=>{const source='https://www.nursejob.co.kr/recruit/recruit_view.php?r_idx=1';const official='https://ncc.recruiter.co.kr/app/jobnotice/view?systemKindCode=MRS2&jobnoticeSn=77';const nurseHtml=`<script type="application/ld+json">${JSON.stringify({'@type':'JobPosting',description:`자세한 내용은 확인해주세요. 출처 : ${official}`})}</script>`;assert.equal(extractOfficialRecruiterUrl(nurseHtml,source)?.href,official);const officialHtml=`<div id="viewSmartEditorContent"><img src="/upload/1/image/page-1.jpg"><img src="https://evil.example/page.jpg"></div><a class="fileWrapperView" href="/mrs2/attachFile/downloadFile?fileUid=notice.pdf">채용공고.pdf</a><a class="fileWrapperView" href="https://evil.example/private.hwp">직무기술서.hwp</a>`;assert.deepEqual(parseOfficialRecruiterAssets(officialHtml,official),{sourceImages:['https://ncc.recruiter.co.kr/upload/1/image/page-1.jpg'],attachments:[{name:'채용공고.pdf',url:'https://ncc.recruiter.co.kr/mrs2/attachFile/downloadFile?fileUid=notice.pdf',type:'PDF'}]})});
test('all additional source parsers return structured jobs',()=>{assert.ok(parseJobKorea(`<div class="rounded-2xl"><a class="mb-0.5" href="/Recruit/GI_Read/1">보건관리자 채용</a><a href="/Recruit/GI_Read/1">테스트기업</a><span>서울 D-3</span></div>`).length);assert.ok(parseCatch(`<table class="table2"><tbody><tr><td><a href="/NCS/RecruitInfoDetails/2" class="tdlink"><span class="t1">캐치기업</span><span class="name">산업간호사</span><span class="t3_2">경기</span></a></td></tr></tbody></table>`).length);assert.ok(parseWork24(`<table id="contentArea"><tbody><tr id="list1"><td><a class="cp_name">고용기업</a><a data-emp-detail href="/wk/a/b/1500/empDetailAuthView.do?wantedAuthNo=K1">보건관리자</a> 부산 채용시까지</td></tr></tbody></table>`).length);assert.ok(parseAlio(`<table><tr><td></td><td></td><td>공공기관</td><td><a href="/recruitview.do?idx=3">보건관리자 채용</a></td></tr></table>`).length)});
test('specialized source parsers return jobs',()=>{assert.ok(parseNurseLink(`<a href="/jobs/4">[~07/20] 테스트기업 산업간호사 부서무관</a>`).length);assert.ok(parseKaohn(`<table><tr><td><a href="/bbs/board.php?tbl=bbs81_1&mode=VIEW&num=5">근로자건강센터 간호사 모집</a></td><td>07-11</td></tr></table>`).length);assert.ok(parseKisanhyup(`<a class="item-subject" href="https://kisanhyup.co.kr/bbs/board.php?bo_table=bd_num7&wr_id=6">보건관리자 모집</a>`).length);assert.ok(parseSnuh(`<a href="/joining/recruit/view.do?recruit_id=7">간호직 채용</a>`).length);assert.ok(parseAmc(`<a onclick="fnDetail('8','9')">외래간호팀 간호사 모집</a>`).length)});
test('Samsung hospital parser keeps nursing roles',()=>{assert.ok(parseSamsung(`<table><tr><td></td><td>간호사</td><td><a href="/home/recruit/recruitInfo/recruitNoticeView.do?RECRUIT_CD=A1">전담간호사 채용</a></td></tr></table>`).length)});
test('legacy and Recruiter connectors keep nursing roles',()=>{assert.ok(parseMedicalJob(`<a href="/job/view.asp?jsn=1">병원명</a><a href="/job/view.asp?jsn=1">외래간호사 채용</a>`).length);assert.ok(parseHospitalJob(`<a title="상세채용정보보기" href="/cms/s01_v.php?idx=2">병동 간호사 채용</a>`).length);assert.ok(parseCmc(`<li><a href="/cmcseoul/application/appView.do?seq_no=3"><strong class="reduce">[서울성모] 외래간호팀 간호직 채용</strong><em class="data">2026.08.20</em></a></li>`).length);assert.ok(parseRecruiter(JSON.stringify({jobnoticeInProgressList:[{jobnoticeSn:4,jobnoticeName:'보건직 직원 채용',deadlineCount:3}]}),{id:'r',company:'병원',source:'병원',region:'경기',origin:'https://example.com'}).length)});

test('focused official hospital parsers keep only active nursing roles',()=>{
  const caseManagerHtml=`<table><tbody><tr><td><a href="/bbs/board.php?bo_table=recruit_people&amp;wr_id=41">[세브란스병원] 보험심사 간호사 계약직 채용</a></td><td class="td_date">2026-08-20</td></tr><tr><td><a href="/bbs/board.php?bo_table=recruit_people&amp;wr_id=42">[대한간호협회] 간호정책팀 직원채용</a></td></tr><tr class="bo_notice"><td><a href="/bbs/board.php?bo_table=recruit_people&amp;wr_id=43">게시판 운영 방식</a></td></tr></tbody></table>`;
  const caseJobs=parseCaseManager(caseManagerHtml);
  assert.equal(caseJobs.length,1);assert.equal(caseJobs[0].employment,'계약직');assert.equal(caseJobs[0].region,'서울');assert.equal(caseJobs[0].publishedAt,'2026-08-20');

  const eumcJobs=parseEumc(JSON.stringify({data:[
    {id:51,title:'[목동병원] 외래간호팀 간호사(계약직) 공개채용',status:{code:'ing'},start:'2026-08-10',end:'2026-08-28',categories:[{text:'계약직'}],links:{'jobs.show':'https://eumc.applyin.co.kr/jobs/51'}},
    {id:52,title:'[서울병원] 진료협력센터 전담인력 채용',status:{code:'ing'},start:'2026-08-10',end:'2026-08-28',categories:[{text:'계약직'}]},
    {id:53,title:'[서울병원] 검진센터 간호사 채용',status:{code:'end'},start:'2026-08-01',end:'2026-08-05'},
  ]}));
  assert.deepEqual(eumcJobs.map(({id})=>id),['eumc-51']);assert.equal(eumcJobs[0].company,'이대목동병원');assert.equal(eumcJobs[0].employment,'계약직');

  const kumcJobs=parseKumc(JSON.stringify({list:[
    {positionSn:61,title:'[안산병원] 심사평가팀 간호사(계약직) 모집',submissionStatus:'IN_SUBMISSION',classificationCode:'안산병원',careerType:'CAREER',recruitmentType:'계약직',startDateTime:'2026-08-10T00:00:00',endDateTime:'2026-08-29T23:59:59'},
    {positionSn:62,title:'[구로병원] 간호부 외래진료과 계약직일반업무원 모집',submissionStatus:'IN_SUBMISSION',classificationCode:'구로병원'},
    {positionSn:63,title:'[안암병원] 외과 전담간호사 모집',submissionStatus:'POST_SUBMISSION',classificationCode:'안암병원'},
  ]}));
  assert.deepEqual(kumcJobs.map(({id})=>id),['kumc-61']);assert.equal(kumcJobs[0].region,'경기');assert.equal(kumcJobs[0].deadline,'2026-08-29');assert.equal(kumcJobs[0].experience,'경력');

  const khmcJobs=parseKhmc(`<ul class="list-item-box"><li><span class="state">모집중</span><span class="title">종양혈액내과 전담간호사(계약직) 채용</span><span class="date">2026.08.18 ~ 2026.08.30</span><a href="/khmc/job/71">상세</a></li><li><span class="state">마감</span><span class="title">진료협력팀 간호사 채용</span><a href="/khmc/job/72">상세</a></li></ul>`);
  assert.deepEqual(khmcJobs.map(({id})=>id),['khmc-71']);assert.equal(khmcJobs[0].employment,'계약직');assert.equal(khmcJobs[0].deadline,'2026-08-30');

  const kuhJobs=parseKuh(`<table><tbody><tr><td><span class="stateNotice">접수중</span></td><td><a href="/recruit/apply/noticeView.do?anc_seq=81">외래간호팀 외래주사실 간호사(계약직) 채용</a></td><td>계약직</td><td>2026.08.19 ~ 2026.08.31</td></tr><tr><td><span class="stateNotice">접수중</span></td><td><a href="/recruit/apply/noticeView.do?anc_seq=83">병동 간호사 채용</a></td><td>정규직</td><td>2026.08.20 ~ 2026.09.01</td></tr><tr><td><span class="stateNotice">접수중</span></td><td><a href="/recruit/apply/noticeView.do?anc_seq=84">의무기록사 채용</a></td><td>계약직</td><td>2026.08.20 ~ 2026.09.01</td></tr><tr><td><span class="stateNotice">마감</span></td><td><a href="/recruit/apply/noticeView.do?anc_seq=82">건강검진센터 간호사 채용</a></td><td>정규직</td><td>2026.08.01 ~ 2026.08.10</td></tr></tbody></table>`);
  assert.deepEqual(kuhJobs.map(({id})=>id),['kuh-81','kuh-83']);assert.equal(kuhJobs[0].employment,'계약직');assert.equal(kuhJobs[0].deadline,'2026-08-31');
});

test('focused Recruiter parser excludes inpatient and non-nursing roles',()=>{
  const jobs=parseRecruiter(JSON.stringify({jobnoticeInProgressList:[
    {jobnoticeSn:91,jobnoticeName:'[일반-강남] 간호사(계약직) 외래간호팀 모집',deadlineCount:5,systemKindCode:'MRS2'},
    {jobnoticeSn:92,jobnoticeName:'[일반] 병동 간호사 모집',deadlineCount:5,systemKindCode:'MRS2'},
    {jobnoticeSn:93,jobnoticeName:'[일반] 검진센터 방사선사 모집',deadlineCount:5,systemKindCode:'MRS2'},
  ]}),{id:'yuhs',company:'연세의료원',source:'연세의료원',region:'서울',origin:'https://yuhs.recruiter.co.kr',focused:true});
  assert.deepEqual(jobs.map(({id})=>id),['yuhs-91']);assert.equal(jobs[0].employment,'계약직');
});

test('requested official sources are automatic collectors',()=>{
  const requested=['casemanager','yuhs','eumc','kumc','khmc','kuh','cmc'];
  assert.deepEqual(requested.map((id)=>SOURCES.find((source)=>source.id===id)?.collection),requested.map(()=>'auto'));
  assert.equal(new Set(SOURCES.map(({id})=>id)).size,SOURCES.length);
});
test('RNJOB SSO result parser returns cards',()=>{assert.ok(parseRnjob(`<article class="card_type1-job"><div class="d-day">D-2</div><div class="company_info"><div class="name">사업장</div><div class="location">서울</div></div><div class="sbject_g"><h3>산업간호사 채용</h3></div><a class="go_drt" href="/recruit/getRecruitInfo.do?rcrutSeq=5"></a></article>`).length)});
test('Wanted search API parser keeps nursing-related positions only',()=>{const jobs=parseWantedPositions({total_count:3,data:[{id:11,position:'기업 보건관리자 채용',employment_type:'regular',annual_from:3,annual_to:8,company:{name:'테스트기업'}},{id:12,position:'프론트엔드 개발자',employment_type:'regular',company:{name:'개발사'}},{id:13,position:'EHS 안전관리자',employment_type:'contract',annual_from:0,annual_to:100,company:{name:'물류사'}}]});assert.deepEqual(jobs.map(({id})=>id),['wanted-11','wanted-13']);assert.equal(jobs[0].company,'테스트기업');assert.equal(jobs[0].employment,'정규직');assert.equal(jobs[0].experience,'경력 3~8년');assert.equal(jobs[1].experience,'신입 가능');assert.match(jobs[0].url,/wanted\.co\.kr\/wd\/11/)});
test('generic detail parser reads JobPosting and labeled fields',()=>{const html=`<script type="application/ld+json">{"@type":"JobPosting","employmentType":"정규직","experienceRequirements":"경력 2년","description":"<p>산업보건 관리와 건강상담을 담당합니다.</p>","jobLocation":{"address":{"addressRegion":"서울","addressLocality":"종로구"}}}</script><table><tr><th>근무시간</th><td>주 5일 09:00~18:00</td></tr><tr><th>모집인원</th><td>2명</td></tr></table>`;const detail=parseGenericJobDetail(html,'https://www.jobkorea.co.kr/Recruit/GI_Read/1');assert.equal(detail.employment,'정규직');assert.equal(detail.workHours,'주 5일 09:00~18:00');assert.equal(detail.headcount,'2명');assert.equal(detail.location,'서울 종로구');assert.match(detail.description,/건강상담/)});
test('generic detail parser prefers the JobKorea embedded posting body over its short schema summary',()=>{const html=`<script type="application/ld+json">${JSON.stringify({'@type':'JobPosting',employmentType:'FULL_TIME',description:'기업에서 정규직 채용을 진행합니다.',preferredQualifications:'자격증'})}</script><div id="detail-content"><p>회사 및 팀 소개</p><p>물류센터의 건강한 작업환경을 만듭니다.</p><p>주요업무</p><p>- 건강검진 유소견자 상담</p><p>- 작업환경 개선</p><p>자격요건</p><p>- 간호사 면허 소지자</p><p>우대사항</p><p>- 산업간호사 실무 경험</p></div>`;const detail=parseGenericJobDetail(html,'https://www.jobkorea.co.kr/Recruit/GI_Read/1');assert.equal(detail.descriptionKind,'content');assert.match(detail.description,/건강검진 유소견자 상담/);assert.match(detail.duties,/작업환경 개선/);assert.match(detail.qualifications,/간호사 면허/);assert.match(detail.preferredQualifications,/산업간호사/);assert.doesNotMatch(detail.preferredQualifications,/^자격증$/);assert.equal(detail.sections[0].title,'회사 및 팀 소개');assert.equal(detail.employment,'정규직')});
test('generic detail parser ignores a zero-only salary placeholder',()=>{const html=`<script type="application/ld+json">${JSON.stringify({'@type':'JobPosting',baseSalary:{'@type':'MonetaryAmount',currency:'KRW',value:{'@type':'QuantitativeValue',minValue:0,maxValue:0,unitText:'YEAR'}}})}</script>`;const detail=parseGenericJobDetail(html,'https://www.wanted.co.kr/wd/1');assert.equal(detail.salary,undefined)});
test('generic Saramin detail exposes only verified original posting images',()=>{const html=`<div class="user_content"><img src="https://pds.saramin.co.kr/recruit/recruit/202609/22/234315_3fc5-808aa4_recruit.jpg"><img src="https://pds.saramin.co.kr/recruit/recruit/202609/22/234315_3fc5-808aa4_recruit.jpg"><img src="https://pds.saramin.co.kr/profile/photo.jpg"><img src="https://evil.example/recruit/recruit/posting.png"></div>`;const detail=parseGenericJobDetail(html,'https://www.saramin.co.kr/zf_user/jobs/relay/view?rec_idx=55102113');assert.deepEqual(detail.sourceImages,['https://pds.saramin.co.kr/recruit/recruit/202609/22/234315_3fc5-808aa4_recruit.jpg']);assert.deepEqual(parseGenericJobDetail(html,'https://www.jobkorea.co.kr/Recruit/GI_Read/1').sourceImages,undefined)});
test('generic detail parser does not mistake a work schedule for employment',()=>{const scheduleOnly=parseGenericJobDetail('<main><p><span>근무형태</span> 주간근무제</p></main>','https://www.casemanager.or.kr/bbs/board.php?bo_table=recruit_people&wr_id=1');assert.equal(scheduleOnly.employment,undefined);const contract=parseGenericJobDetail('<table><tr><th>고용형태</th><td>계약직 / 주 5일</td></tr></table>','https://www.casemanager.or.kr/bbs/board.php?bo_table=recruit_people&wr_id=2');assert.equal(contract.employment,'계약직')});
test('generic detail parser preserves confirmed heading sections',()=>{const html=`<main><section><h3>담당업무</h3><ul><li>사내 보건 관리</li><li>응급처치</li></ul></section><section><h3>자격요건</h3><ul><li>간호사 면허</li></ul></section><section><h3>우대사항</h3><p>동종업계 유경험자</p></section><section><h3>전형절차</h3><ol><li>서류전형</li><li>면접전형</li></ol></section><section><h3>지원방법</h3><p>채용 홈페이지 지원</p></section><section><h3>기타사항</h3><p>중복지원 불가</p></section><section><h3>마감기한</h3><p>2026년 7월 19일까지</p></section></main>`;const detail=parseGenericJobDetail(html,'https://www.jobkorea.co.kr/Recruit/GI_Read/1');assert.match(detail.duties,/사내 보건 관리/);assert.match(detail.qualifications,/간호사 면허/);assert.match(detail.preferredQualifications,/동종업계/);assert.match(detail.recruitmentProcess,/면접전형/);assert.match(detail.applicationMethod,/채용 홈페이지/);assert.match(detail.otherInformation,/중복지원/);assert.match(detail.deadlineText,/7월 19일/);assert.equal(detail.descriptionKind,'content')});
test('generic detail parser structures labeled sections embedded in JobPosting description',()=>{const description=['담당업무','사내 보건 관리','산업안전보건법에 따른 보건관리자 업무 전반','자격요건','간호사 면허 소지자','우대사항','동종업계 유경험자','전형절차','서류전형','면접전형','지원방법','채용 홈페이지 입사지원','기타사항','중복지원 불가','마감기한','2026년 7월 19일 23:59까지'].join('<br>');const html=`<script type="application/ld+json">${JSON.stringify({'@type':'JobPosting',description})}</script>`;const detail=parseGenericJobDetail(html,'https://www.jobkorea.co.kr/Recruit/GI_Read/1');assert.match(detail.duties,/보건관리자 업무 전반/);assert.match(detail.qualifications,/간호사 면허/);assert.match(detail.preferredQualifications,/동종업계/);assert.match(detail.recruitmentProcess,/서류전형\n면접전형/);assert.match(detail.applicationMethod,/입사지원/);assert.match(detail.otherInformation,/중복지원/);assert.match(detail.deadlineText,/23:59/)});
test('generic detail parser recognizes spaced labels, emoji headings, and work conditions',()=>{const description=['📌 담당 업무','임직원 건강상담','✅ 지원 조건','간호사 면허 소지자','근무 조건','주 5일&nbsp;09:00~18:00','지원기간 및 방법','채용 홈페이지 지원'].join('<br>');const html=`<script type="application/ld+json">${JSON.stringify({'@type':'JobPosting',description})}</script>`;const detail=parseGenericJobDetail(html,'https://www.jobkorea.co.kr/Recruit/GI_Read/1');assert.match(detail.duties,/건강상담/);assert.match(detail.qualifications,/간호사 면허/);assert.match(detail.workConditions,/주 5일 09:00~18:00/);assert.match(detail.applicationMethod,/채용 홈페이지/);assert.doesNotMatch(detail.description,/&nbsp;/)});
test('generic detail parser removes a bullet-prefixed field label without truncating its value',()=>{const detail=parseGenericJobDetail('<main><p>• <span>접수기간</span>: 채용시 마감</p></main>','https://www.jobkorea.co.kr/Recruit/GI_Read/1');assert.equal(detail.deadlineText,'채용시 마감')});
test('generic detail parser cleans legacy MedicalJob table separators and empty sections',()=>{const html=`<table><tr><td class="css_apply"><div>모집요강</div><div>· 모집분야</div><div>|</div><div>간호/의료/행정/기타</div><div>· 근무지</div><div>|</div><div>경기</div><div>· 모집인원</div><div>|</div><div>0명</div><div>· 고용형태</div><div>|</div><div>기타</div><div>· 자격요건</div><div>경력</div><div>경력 1년이상</div><div>학력</div><div>무관</div><div>급여조건</div><div>면접시 협의</div><div>제출서류 및 전형방법</div><div>· 제출서류</div><div>|</div><div>· 전형방법</div><div>|</div><div>· 복리후생</div><div>|</div><div>마감일 및 지원방법</div><div>· 마감일</div><div>2026-09-06</div><div>· 지원방법</div><div>[홈페이지]</div><div>온라인 입사지원 시스템을 이용하시기 바랍니다.</div><div>이 페이지를</div><div>채용담당자 정보</div><div>· 담당자명</div><div>채용담당자</div><div>· 홈페이지</div><div>http://hosp.ajoumc.or.kr</div></td></tr></table>`;const detail=parseGenericJobDetail(html,'https://www.medicaljob.co.kr/job/view.asp?jsn=593397');assert.equal(detail.location,'경기');assert.equal(detail.salary,'면접시 협의');assert.equal(detail.headcount,undefined);assert.equal(detail.recruitmentProcess,undefined);assert.deepEqual(detail.welfare,undefined);assert.deepEqual(detail.sections.map(({semanticKey})=>semanticKey),['introduction','qualifications','deadlineText','applicationMethod']);assert.doesNotMatch(detail.applicationMethod,/이 페이지를|\|/)});
test('Wanted detail parser preserves the complete source section order',()=>{const wanted={id:374043,position:'[아이디어스] 안드로이드 개발자',status:'active',due_time:null,close_time:null,employment_type:'regular',career:{annual_from:3,annual_to:8},address:{full_location:'서울 서초구'},company:{company_name:'백패커'},intro:'■ 백패커는?\n회사 소개\n\n■ 유닛/셀 소개\n모바일셀 소개\n\n■ 우리는 이렇게 일해요\n• 코드 리뷰로 신뢰를 쌓아요',main_tasks:'• Android 앱 개발',requirements:'• Kotlin 개발 경험',preferred_points:'• Jetpack Compose 경험',benefits:'[Health]\n• 건강검진\n[Growth]\n• 교육 지원',hire_rounds:'서류전형\n면접전형'};const html=`<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({props:{pageProps:{initialData:wanted}}})}</script>`;const detail=parseWantedDetail(html);assert.equal(detail.experience,'3년~8년');assert.equal(detail.employment,'정규직');assert.equal(detail.deadlineText,'상시채용');assert.deepEqual(detail.sections.map(({title})=>title),['소개','유닛/셀 소개','우리는 이렇게 일해요','주요업무','자격요건','우대사항','혜택 및 복지','전형절차']);assert.match(detail.sections.find(({semanticKey})=>semanticKey==='benefits').value,/\[Growth\]/)});
test('detail URLs keep the parameters required by source sites',()=>{const amc=parseAmc(`<a onclick="fnDetail('8','9')">외래간호팀 간호사 모집</a>`)[0];assert.match(amc.url,/scheduleno=9/);const recruiter=parseRecruiter(JSON.stringify({jobnoticeInProgressList:[{jobnoticeSn:4,jobnoticeName:'보건직 직원 채용',systemKindCode:'MRS2'}]}),{id:'r',company:'병원',source:'병원',region:'경기',origin:'https://example.com'})[0];assert.match(recruiter.url,/systemKindCode=MRS2/)});

test('job detail API reads EUMC and KUMC platform JSON as verified detail',async(t)=>{
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
  const originalFetch=globalThis.fetch;t.after(()=>{globalThis.fetch=originalFetch});const remoteRequests=[];
  globalThis.fetch=async(input,options={})=>{
    const requestUrl=String(input);remoteRequests.push({requestUrl,options});
    if(requestUrl==='https://eumc.applyin.co.kr/jobs/51')return new Response(JSON.stringify({data:{title:'[목동병원] 외래간호팀 간호사(계약직)',content:'<h3>담당업무</h3><p>외래 환자 상담</p><h3>자격요건</h3><p>간호사 면허 소지자</p><h3>근무조건</h3><p>월~금 08:30~17:30</p>',categories:[{text:'계약직'}],start:'2026-08-10',end:'2026-08-28'}}),{status:200,headers:{'content-type':'application/json'}});
    if(requestUrl==='https://api-recruiter.recruiter.co.kr/position/v2/jobflex/61')return new Response(JSON.stringify({title:'[안산병원] 심사평가팀 계약직직원 모집',jobDescription:'<h3>응시자격</h3><p>간호사 면허 소지자</p><h3>담당업무</h3><p>심사평가 업무 전반</p><h3>근무조건</h3><p>주간근무제</p>',recruitmentType:'계약직',careerType:'CAREER',classificationCode:'안산병원',startDateTime:'2026-08-10',endDateTime:'2026-08-31'}),{status:200,headers:{'content-type':'application/json'}});
    return originalFetch(input,options);
  };
  const {port}=server.address();
  const requestDetail=async(url)=>originalFetch(`http://127.0.0.1:${port}/api/job-detail`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({refresh:true,url,job:{title:'간호사 채용'}})}).then(response=>response.json());
  const eumc=await requestDetail('https://eumc.applyin.co.kr/jobs/51');assert.equal(eumc.detailVerified,true);assert.equal(eumc.employment,'계약직');assert.match(eumc.duties,/외래 환자 상담/);assert.match(eumc.qualifications,/간호사 면허/);
  const kumc=await requestDetail('https://kumc.recruiter.co.kr/career/jobs/61');assert.equal(kumc.detailVerified,true);assert.equal(kumc.employment,'계약직');assert.equal(kumc.experience,'경력');assert.match(kumc.duties,/심사평가 업무/);assert.equal(kumc.location,'경기');
  assert.equal(remoteRequests[0].options.headers['x-requested-with'],'XMLHttpRequest');assert.equal(remoteRequests[1].options.headers.prefix,'kumc.recruiter.co.kr');
});
test('job detail API route always returns JSON for rejected hosts',async(t)=>{const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));const {port}=server.address();const response=await fetch(`http://127.0.0.1:${port}/api/job-detail`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url:'https://example.com/job/1'})});assert.equal(response.status,400);assert.match(response.headers.get('content-type'),/application\/json/);assert.equal((await response.json()).error,'등록되지 않은 채용처 주소입니다.')});
test('job detail API keeps and classifies experience-only fallback detail',async(t)=>{const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));const originalFetch=globalThis.fetch;t.after(()=>{globalThis.fetch=originalFetch});globalThis.fetch=async(input,options)=>{if(String(input).startsWith('https://www.nursejob.co.kr/'))throw new Error('blocked fixture');return originalFetch(input,options)};const {port}=server.address();const response=await originalFetch(`http://127.0.0.1:${port}/api/job-detail`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url:'https://www.nursejob.co.kr/recruit/recruit_view.php?r_idx=1',job:{title:'보건관리자 채용',experience:'보건관리자 경력 2년 이상'}})});assert.equal(response.status,200);const detail=await response.json();assert.equal(detail.experience,'보건관리자 경력 2년 이상');assert.equal(detail.experienceDomain,'health-manager');assert.equal(detail.detailVerified,false);assert.equal(detail.detailOrigin,'feed-fallback');assert.ok(['title','experience'].includes(detail.experienceEvidence.field));assert.ok(detail.experienceEvidence.excerpt)});

test('job detail API reuses a verified response on a warm server instance', async (t) => {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const detailUrl = 'https://www.jobkorea.co.kr/Recruit/GI_Read/987650';
  let remoteRequestCount = 0;
  globalThis.fetch = async (input, options) => {
    if (String(input) === detailUrl) {
      remoteRequestCount += 1;
      return new Response('<main><h3>담당업무</h3><p>임직원 건강상담과 보건교육</p><h3>자격요건</h3><p>간호사 면허 소지자</p></main>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
    return originalFetch(input, options);
  };
  const { port } = server.address();
  const requestDetail = (refresh = false) => originalFetch(`http://127.0.0.1:${port}/api/job-detail`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refresh, url: detailUrl, job: { title: '사업장 보건관리자 간호사 채용' } }),
  });

  const first = await requestDetail(true);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('x-nurse-board-detail-cache'), 'refresh');
  assert.equal((await first.json()).detailVerified, true);
  const second = await requestDetail();
  assert.equal(second.status, 200);
  assert.equal(second.headers.get('x-nurse-board-detail-cache'), 'hit');
  assert.equal((await second.json()).detailVerified, true);
  assert.equal(remoteRequestCount, 1);
});

test('job detail API verifies the original and classifies experience stated only in preferred qualifications', async (t) => {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (input) => {
    if (String(input).startsWith('https://www.jobkorea.co.kr/')) {
      return new Response('<main><h3>우대사항</h3><p>산업보건 경력 2년 이상</p></main>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
    return originalFetch(input);
  };
  const { port } = server.address();
  const response = await originalFetch(`http://127.0.0.1:${port}/api/job-detail`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refresh: true,
      url: 'https://www.jobkorea.co.kr/Recruit/GI_Read/1',
      job: {
        title: '간호사 채용',
        experience: '경력 2년 이상',
        headcount: '0명',
        workConditions: '모집인원: 0명',
        recruitmentProcess: '· 복리후생\n마감일 및 지원방법',
      },
    }),
  });
  assert.equal(response.status, 200);
  const detail = await response.json();
  assert.equal(detail.detailVerified, true);
  assert.equal(detail.detailOrigin, 'original');
  assert.equal(detail.experienceDomain, 'health-manager');
  assert.equal(detail.experienceEvidence.field, 'preferredQualifications');
  assert.equal(detail.headcount, undefined);
  assert.equal(detail.workConditions, undefined);
  assert.equal(detail.recruitmentProcess, undefined);
});

test('job detail API follows the JobKorea embedded detail document', async (t) => {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const remoteRequests = [];
  globalThis.fetch = async (input, options) => {
    const requestUrl = String(input);
    if (requestUrl.startsWith('https://www.jobkorea.co.kr/')) {
      remoteRequests.push({ requestUrl, options });
      const body = requestUrl.includes('/GI_Read_Comt_Ifrm')
        ? '<div id="detail-content"><p>회사 및 팀 소개</p><p>물류 운영을 지원합니다.</p><p>주요업무</p><p>- 유소견자 건강상담</p><p>자격요건</p><p>- 간호사 면허 소지자</p><p>우대사항</p><p>- 산업간호 경력자</p></div>'
        : `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', employmentType: 'FULL_TIME', description: '정규직 채용 요약', preferredQualifications: '자격증' })}</script><script>self.__next_f.push([1,"/Recruit/GI_Read_Comt_Ifrm?Gno=99\\u0026isHiringCenter=false"])</script>`;
      return new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    return originalFetch(input, options);
  };
  const { port } = server.address();
  const response = await originalFetch(`http://127.0.0.1:${port}/api/job-detail`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refresh: true, url: 'https://www.jobkorea.co.kr/Recruit/GI_Read/99', job: { title: '물류센터 보건관리자', source: '잡코리아' } }),
  });
  assert.equal(response.status, 200);
  const detail = await response.json();
  assert.equal(remoteRequests.length, 2);
  assert.match(remoteRequests[1].requestUrl, /\/Recruit\/GI_Read_Comt_Ifrm\?Gno=99/);
  assert.match(detail.duties, /유소견자 건강상담/);
  assert.match(detail.qualifications, /간호사 면허/);
  assert.match(detail.preferredQualifications, /산업간호 경력자/);
  assert.equal(detail.sections[0].title, '회사 및 팀 소개');
  assert.equal(detail.descriptionKind, 'content');
  assert.equal(detail.detailBodyAvailable, true);
  assert.equal(detail.detailOrigin, 'original');
});

test('job detail API follows the Saramin embedded detail document', async (t) => {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const remoteRequests = [];
  globalThis.fetch = async (input, options) => {
    const requestUrl = String(input);
    if (requestUrl.startsWith('https://www.saramin.co.kr/')) {
      remoteRequests.push({ requestUrl, options });
      const body = requestUrl.includes('/view-detail')
        ? '<div class="user_content"><h2>담당 업무</h2><p>임직원 건강상담과 보건교육</p><h2>자격 요건</h2><p>간호사 면허 소지자</p><h2>근무 조건</h2><p>주 5일 09:00~18:00</p><h2>지원기간 및 방법</h2><p>사람인 온라인 지원</p><img src="https://pds.saramin.co.kr/recruit/recruit/202609/22/posting.jpg" alt="공고"></div>'
        : '<html><head><meta name="description" content="사람인 채용공고"></head><body></body></html>';
      return new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    return originalFetch(input, options);
  };
  const { port } = server.address();
  const response = await originalFetch(`http://127.0.0.1:${port}/api/job-detail`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refresh: true, url: 'https://www.saramin.co.kr/zf_user/jobs/relay/view?rec_idx=99', job: { title: '보건관리자 채용', source: '사람인' } }),
  });
  assert.equal(response.status, 200);
  const detail = await response.json();
  assert.equal(remoteRequests.length, 2);
  assert.match(remoteRequests[1].requestUrl, /\/view-detail\?rec_idx=99&rec_seq=0/);
  assert.match(remoteRequests[1].options.headers.referer, /rec_idx=99/);
  assert.match(detail.duties, /건강상담/);
  assert.match(detail.qualifications, /간호사 면허/);
  assert.match(detail.workConditions, /주 5일/);
  assert.match(detail.applicationMethod, /온라인 지원/);
  assert.deepEqual(detail.sourceImages, ['https://pds.saramin.co.kr/recruit/recruit/202609/22/posting.jpg']);
  assert.equal(detail.descriptionKind, 'content');
  assert.equal(detail.detailBodyAvailable, true);
  assert.equal(detail.detailOrigin, 'original');
});

test('job detail API follows the official Recruiter notice linked by NurseJob', async (t) => {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const officialUrl = 'https://ncc.recruiter.co.kr/app/jobnotice/view?systemKindCode=MRS2&jobnoticeSn=77';
  const pdfUrl = 'https://ncc.recruiter.co.kr/mrs2/attachFile/downloadFile?fileUid=notice.pdf';
  const hwpUrl = 'https://ncc.recruiter.co.kr/mrs2/attachFile/downloadFile?fileUid=role.hwp';
  const remoteRequests = [];
  globalThis.fetch = async (input, options) => {
    const requestUrl = String(input);
    remoteRequests.push({ requestUrl, options });
    if (requestUrl.startsWith('https://www.nursejob.co.kr/')) {
      const description = `자세한 채용사항은 병원 홈페이지를 확인해주세요.\n출처 : ${officialUrl}`;
      return new Response(`<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', employmentType: '정규직', description })}</script>`, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    if (requestUrl === officialUrl) {
      return new Response(`<div id="viewSmartEditorContent"><img src="/upload/1/image/page-1.jpg"></div><a class="fileWrapperView" href="${pdfUrl}">채용공고.pdf</a><a class="fileWrapperView" href="/mrs2/attachFile/downloadFile?fileUid=role.hwp">직무기술서.hwp</a>`, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    if (requestUrl === pdfUrl) return new Response('not a pdf', { status: 200, headers: { 'content-type': 'application/pdf' } });
    if (requestUrl === hwpUrl) return new Response('unavailable', { status: 503 });
    return originalFetch(input, options);
  };
  const { port } = server.address();
  const response = await originalFetch(`http://127.0.0.1:${port}/api/job-detail`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refresh: true, url: 'https://www.nursejob.co.kr/recruit/recruit_view.php?r_idx=1', job: { title: '정규직 간호직 채용', source: '널스잡' } }),
  });
  assert.equal(response.status, 200);
  const detail = await response.json();
  assert.equal(detail.officialSourceUrl, officialUrl);
  assert.deepEqual(detail.sourceImages, ['https://ncc.recruiter.co.kr/upload/1/image/page-1.jpg']);
  assert.deepEqual(detail.attachments.map(({ name, type }) => ({ name, type })), [{ name: '채용공고.pdf', type: 'PDF' }, { name: '직무기술서.hwp', type: 'HWP' }]);
  assert.equal(detail.detailBodyAvailable, true);
  assert.equal(detail.detailOrigin, 'original');
  assert.deepEqual(remoteRequests.map(({ requestUrl }) => requestUrl), ['https://www.nursejob.co.kr/recruit/recruit_view.php?r_idx=1', officialUrl, hwpUrl, pdfUrl]);
  assert.ok(detail.attachments.every((attachment) => attachment.extractionStatus === 'unavailable'));
});

test('job detail API follows a linked Hallym notice and prefers its full detail', async (t) => {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const remoteRequests = [];
  globalThis.fetch = async (input, options) => {
    const requestUrl = String(input);
    remoteRequests.push(requestUrl);
    if (requestUrl.startsWith('https://www.nursejob.co.kr/')) {
      const description = `자세한 채용사항은 병원 홈페이지를 확인해주세요.\n출처 : ${HALLYM_DETAIL_URL}`;
      return new Response(`<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', employmentType: '정규직', experienceRequirements: '경력무관', description })}</script><a href="${HALLYM_DETAIL_URL}">공식 공고</a>`, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    if (requestUrl === HALLYM_DETAIL_URL) return new Response(hallymDetailFixture(), { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    return originalFetch(input, options);
  };
  const { port } = server.address();
  const response = await originalFetch(`http://127.0.0.1:${port}/api/job-detail`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refresh: true, url: 'https://www.nursejob.co.kr/recruit/recruit_view.php?r_idx=1205157', job: { title: '전담간호사 공개채용', source: '널스잡', region: '경기' } }),
  });
  assert.equal(response.status, 200);
  const detail = await response.json();
  assert.equal(detail.officialSourceUrl, HALLYM_DETAIL_URL);
  assert.equal(detail.department, '복수 진료과(2개 분야)');
  assert.equal(detail.workPattern, '3교대·주근제(부서별)');
  assert.match(detail.experience, /임상경력 36개월 이상/);
  assert.match(detail.qualifications, /최종합격 후 즉시 근무/);
  assert.match(detail.applicationMethod, /온라인 접수/);
  assert.equal(detail.sections.length, 10);
  assert.equal(detail.descriptionKind, 'content');
  assert.equal(detail.detailBodyAvailable, true);
  assert.deepEqual(remoteRequests, ['https://www.nursejob.co.kr/recruit/recruit_view.php?r_idx=1205157', HALLYM_DETAIL_URL]);
});
