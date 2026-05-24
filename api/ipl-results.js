const BASE = 'https://site.api.espn.com/apis/site/v2/sports/cricket/8048';

// Map ESPN event names/teams to our match IDs
function mapToMatchId(event) {
  const name = (event?.name || '').toLowerCase();
  const competitors = event?.competitions?.[0]?.competitors || [];
  const teams = competitors.map(c =>
    (c?.team?.abbreviation || c?.team?.displayName || '').toLowerCase()
  );
  const both = teams.join(' ');

  if ((both.includes('mi') || name.includes('mumbai')) &&
      (both.includes('rr') || name.includes('rajasthan'))) return 'mi-rr';
  if ((both.includes('kkr') || name.includes('kolkata')) &&
      (both.includes('dc') || name.includes('delhi'))) return 'kkr-dc';
  if ((both.includes('rcb') || name.includes('royal challengers') || name.includes('bangalore') || name.includes('bengaluru')) &&
      (both.includes('gt') || name.includes('gujarat'))) return 'q1';
  if ((both.includes('srh') || name.includes('sunrisers') || name.includes('hyderabad')) &&
      (both.includes('rr') || name.includes('rajasthan'))) return 'elim';
  // Q2 and Final teams are TBD — match by date
  if (name.includes('qualifier 2') || name.includes('qual 2')) return 'q2';
  if (name.includes('final') && !name.includes('qualifier') && !name.includes('semi')) return 'final';
  return null;
}

async function fetchSummary(eventId) {
  try {
    const res = await fetch(`${BASE}/summary?event=${eventId}`, {
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

function extractPlayerStats(summary) {
  let topScorer = null, topWickets = null, potm = null;

  // Player of the Match from awards
  const awards = summary?.awards || [];
  for (const award of awards) {
    const aName = (award?.name || '').toLowerCase();
    if (aName.includes('player') && aName.includes('match')) {
      potm = award?.player?.displayName || award?.players?.[0]?.displayName || null;
    }
  }

  // Try batting/bowling from boxscore
  const boxscore = summary?.boxscore || summary?.innings || [];
  let maxRuns = -1, maxWickets = -1;

  const innings = Array.isArray(boxscore) ? boxscore : (boxscore?.innings || []);
  for (const inning of innings) {
    const batters = inning?.batters || inning?.batting || [];
    for (const b of batters) {
      const runs = parseInt(b?.runs ?? b?.score ?? b?.stat?.runs ?? -1);
      const name = b?.athlete?.displayName || b?.player?.displayName || b?.name;
      if (name && runs > maxRuns) { maxRuns = runs; topScorer = `${name} (${runs} runs)`; }
    }
    const bowlers = inning?.bowlers || inning?.bowling || [];
    for (const b of bowlers) {
      const wkts = parseInt(b?.wickets ?? b?.stat?.wickets ?? -1);
      const name = b?.athlete?.displayName || b?.player?.displayName || b?.name;
      if (name && wkts > maxWickets) { maxWickets = wkts; topWickets = `${name} (${wkts} wickets)`; }
    }
  }

  return { topScorer, topWickets, potm };
}

function buildAnswers(event, summary) {
  const resultSummary = event?.status?.summary || event?.status?.detail || 'Match completed';
  const competitors = event?.competitions?.[0]?.competitors || [];
  const { topScorer, topWickets, potm } = extractPlayerStats(summary || {});

  // Winner name from result summary
  const winnerTeam = competitors.find(c => c?.winner === true)?.team?.displayName || null;

  return {
    result: resultSummary,
    answers: [
      winnerTeam ? `${winnerTeam} — ${resultSummary}` : resultSummary,
      summary?.toss || 'Check match scorecard for toss details',
      topScorer || 'Check scorecard for top scorer',
      topWickets || 'Check scorecard for top wicket-taker',
      topScorer ? `${topScorer.split(' (')[0]} (top scorer, ideal captain pick)` : 'Check scorecard',
      resultSummary,
      potm || (winnerTeam ? `Best performer from ${winnerTeam}` : 'Check match details for POTM')
    ]
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=60');

  try {
    // Fetch IPL scoreboard (today + yesterday to catch recently finished matches)
    const today = new Date();
    const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
    const fmt = d => d.toISOString().slice(0,10).replace(/-/g,'');

    const [resA, resB] = await Promise.all([
      fetch(`${BASE}/scoreboard?dates=${fmt(today)}`, { signal: AbortSignal.timeout(10000) }),
      fetch(`${BASE}/scoreboard?dates=${fmt(yesterday)}`, { signal: AbortSignal.timeout(10000) })
    ]);

    const [dataA, dataB] = await Promise.all([
      resA.ok ? resA.json() : { events: [] },
      resB.ok ? resB.json() : { events: [] }
    ]);

    const allEvents = [...(dataA?.events || []), ...(dataB?.events || [])];

    // Dedupe by event ID
    const seen = new Set();
    const events = allEvents.filter(e => {
      if (!e?.id || seen.has(e.id)) return false;
      seen.add(e.id); return true;
    });

    // Filter to completed matches only
    const completed = events.filter(e =>
      e?.status?.type?.completed === true ||
      (e?.status?.type?.description || '').toLowerCase() === 'final'
    );

    const results = {};

    await Promise.all(completed.map(async (event) => {
      const matchId = mapToMatchId(event);
      if (!matchId) return;
      const summary = await fetchSummary(event.id);
      results[matchId] = buildAnswers(event, summary);
    }));

    res.status(200).json({ success: true, results, fetchedAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}
