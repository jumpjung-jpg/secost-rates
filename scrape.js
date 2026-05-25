'use strict';
// 한국 정부/공공기관 사이트에서 세율을 자동 스크래핑하여 rates.json 갱신
const axios   = require('axios');
const cheerio = require('cheerio');
const fs      = require('fs');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ko-KR,ko;q=0.9',
};

async function get(url) {
  const res = await axios.get(url, { headers: HEADERS, timeout: 20000 });
  return res.data;
}

// ── 건강보험료율 (nhis.or.kr) ──────────────────────────────────────────────
async function scrapeHealth() {
  try {
    const html = await get('https://www.nhis.or.kr/nhis/policy/wbhaca00300m01.do');
    const text = cheerio.load(html).text();

    // "직장가입자" 다음에 나오는 n.nnn% 패턴 검색
    let empRate = null, ltcRatio = null;

    const totalMatch = text.match(/직장가입자[^0-9]{0,30}([67]\.[0-9]+)\s*%/);
    if (totalMatch) {
      empRate = parseFloat(totalMatch[1]) / 100 / 2; // 총률의 절반 = 근로자 부담
    }

    const empMatch = text.match(/근로자[^0-9]{0,20}([0-9]+\.[0-9]+)\s*%/);
    if (empMatch) {
      const v = parseFloat(empMatch[1]) / 100;
      if (v > 0.02 && v < 0.08) empRate = v;
    }

    const ltcMatch = text.match(/장기요양보험료율[^0-9]{0,20}([0-9]+\.[0-9]+)\s*%/);
    if (ltcMatch) {
      ltcRatio = parseFloat(ltcMatch[1]) / 100;
    }

    // 유효 범위 검증 (건강보험료율 2~8%)
    if (empRate && empRate > 0.02 && empRate < 0.08) {
      return { empRate, erRate: empRate, ltcRatio };
    }
  } catch (e) {
    console.warn('⚠️  건강보험 스크래핑 실패:', e.message);
  }
  return null;
}

// ── 국민연금 기준소득월액 상한·하한 (nps.or.kr) ───────────────────────────
async function scrapePension() {
  try {
    const html = await get('https://www.nps.or.kr/jsppage/info/easy/easy_04_01.jsp');
    const text = cheerio.load(html).text();

    // 금액 단위 "원" 앞 숫자 전체 수집 후 범위로 필터
    const amounts = [...text.matchAll(/([0-9,]+)\s*원/g)]
      .map(m => parseInt(m[1].replace(/,/g, ''), 10))
      .filter(n => !isNaN(n) && n > 0);

    // 하한: 300,000~700,000, 상한: 4,000,000~8,000,000 범위에서 가장 많이 등장한 값
    const freq = arr => arr.reduce((acc, v) => { acc[v] = (acc[v] || 0) + 1; return acc; }, {});
    const top  = obj => Object.entries(obj).sort((a,b) => b[1]-a[1])[0];

    const minArr = amounts.filter(n => n >= 300000 && n <= 700000);
    const maxArr = amounts.filter(n => n >= 4000000 && n <= 8000000);

    if (minArr.length && maxArr.length) {
      return {
        min: parseInt(top(freq(minArr))[0], 10),
        max: parseInt(top(freq(maxArr))[0], 10),
      };
    }
  } catch (e) {
    console.warn('⚠️  국민연금 스크래핑 실패:', e.message);
  }
  return null;
}

// ── 고용보험료율 (ei.go.kr) ────────────────────────────────────────────────
async function scrapeEmployment() {
  try {
    const html = await get('https://www.ei.go.kr/ei/eih/eg/eb/ebD/retrieveInsrRateInfoList.do');
    const text = cheerio.load(html).text();

    // 근로자 부담 0.9% 근처 검색 (고용보험은 거의 변동 없음)
    const match = text.match(/근로자[^0-9]{0,20}([0-9]+\.[0-9]+)\s*%/);
    if (match) {
      const v = parseFloat(match[1]) / 100;
      if (v > 0.005 && v < 0.03) return { empRate: v, erRate: v };
    }
  } catch (e) {
    console.warn('⚠️  고용보험 스크래핑 실패:', e.message);
  }
  return null;
}

// ── 소득세 과세표준 구간 (law.go.kr) ─────────────────────────────────────
async function scrapeIncomeTaxBrackets() {
  try {
    // 법제처 API — 소득세법 제55조 조문 조회 (API 키 불필요)
    const url = 'https://www.law.go.kr/DRF/lawService.do?OC=samplekey&target=lsInfoP&type=HTML&query=%EC%86%8C%EB%93%9D%EC%84%B8%EB%B2%95&lsiSeq=0';
    // 법제처 공개 HTML 페이지 직접 파싱
    const html = await get('https://www.law.go.kr/법령/소득세법');
    const $ = cheerio.load(html);
    const text = $.text();

    // 세율 구간 숫자 패턴: "6%" "15%" "24%" 등이 함께 등장하면 변동 없음으로 판단
    const rates = [6, 15, 24, 35, 38, 40, 42, 45];
    const found = rates.filter(r => text.includes(r + '%') || text.includes(r + ' %'));
    if (found.length >= 6) {
      console.log('ℹ️  소득세 과세표준 구간 변경 없음 (법제처 확인)');
    } else {
      console.warn('⚠️  소득세 구간 확인 불가 — 수동 확인 권장');
    }
  } catch (e) {
    console.warn('⚠️  소득세 법령 스크래핑 실패:', e.message);
  }
  return null; // 구간 자동 변경은 위험 → 알림만
}

// ── 메인 ──────────────────────────────────────────────────────────────────
async function main() {
  console.log('🔍 세율 스크래핑 시작 —', new Date().toLocaleString('ko-KR'));

  const rates   = JSON.parse(fs.readFileSync('rates.json', 'utf-8'));
  let   changed = false;
  const changes = [];

  // 1. 건강보험료율
  const health = await scrapeHealth();
  if (health) {
    if (health.empRate && Math.abs(health.empRate - rates.ins.health.empRate) > 0.000005) {
      changes.push(`건강보험료율(근로자): ${(rates.ins.health.empRate*100).toFixed(3)}% → ${(health.empRate*100).toFixed(3)}%`);
      rates.ins.health.empRate = Math.round(health.empRate * 100000) / 100000;
      rates.ins.health.erRate  = rates.ins.health.empRate;
      changed = true;
    }
    if (health.ltcRatio && Math.abs(health.ltcRatio - rates.ins.health.ltcRatio) > 0.000005) {
      changes.push(`장기요양보험료율: ${(rates.ins.health.ltcRatio*100).toFixed(2)}% → ${(health.ltcRatio*100).toFixed(2)}%`);
      rates.ins.health.ltcRatio = Math.round(health.ltcRatio * 10000) / 10000;
      changed = true;
    }
  } else {
    console.log('⏭️  건강보험료율: 스크래핑 실패 → 기존값 유지');
  }

  // 2. 국민연금 기준소득월액
  const pension = await scrapePension();
  if (pension) {
    if (pension.min !== rates.ins.pension.min) {
      changes.push(`국민연금 하한: ${rates.ins.pension.min.toLocaleString()}원 → ${pension.min.toLocaleString()}원`);
      rates.ins.pension.min = pension.min;
      changed = true;
    }
    if (pension.max !== rates.ins.pension.max) {
      changes.push(`국민연금 상한: ${rates.ins.pension.max.toLocaleString()}원 → ${pension.max.toLocaleString()}원`);
      rates.ins.pension.max = pension.max;
      changed = true;
    }
  } else {
    console.log('⏭️  국민연금 기준소득월액: 스크래핑 실패 → 기존값 유지');
  }

  // 3. 고용보험료율
  const emp = await scrapeEmployment();
  if (emp && Math.abs(emp.empRate - rates.ins.employment.empRate) > 0.000005) {
    changes.push(`고용보험료율(근로자): ${(rates.ins.employment.empRate*100).toFixed(1)}% → ${(emp.empRate*100).toFixed(1)}%`);
    rates.ins.employment.empRate = emp.empRate;
    rates.ins.employment.erRate  = emp.erRate;
    changed = true;
  }

  // 4. 소득세 구간 — 감지만 (자동 변경 없음)
  await scrapeIncomeTaxBrackets();

  // ── 저장 ──
  if (changed) {
    const [year, patch] = rates.version.split('.');
    rates.version = `${year}.${parseInt(patch, 10) + 1}`;
    rates.updated = new Date().toISOString().split('T')[0];
    fs.writeFileSync('rates.json', JSON.stringify(rates, null, 2));

    console.log('\n✅ rates.json 업데이트 완료 — 버전:', rates.version);
    changes.forEach(c => console.log('   •', c));
  } else {
    console.log('\n✅ 변경사항 없음 — 기존 세율 유지');
  }
}

main().catch(e => {
  console.error('❌ 오류:', e.message);
  process.exit(1);
});
