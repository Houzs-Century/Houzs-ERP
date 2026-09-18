-- ----------------------------------------------------------------------------
-- 20260911T1745 — fill the missing Melaka postcodes from the official Pos
-- Malaysia postcode API (owner 2026-09-11: "官方 API 重抓").
--
-- scm.my_localities held only 37 of Melaka's ~116 real postcodes — the entire
-- 755xx block was absent — because the community dataset it was seeded from
-- (AsyrafHussin/heiswayi) shares that gap. Every other MY state is complete
-- against that set; Melaka was the one real hole (docs/bugs/0816 records the
-- separate double-seed found in the same investigation).
--
-- These 77 rows were pulled LIVE from the official API on 2026-09-11:
--   https://api.pos.com.my/PostcodeWebApi/api/Postcode?Postcode=<code>
-- for the 80 Melaka codes we lacked. 3 of the 80 (75610 / 75618 / 75662) the
-- official API returns nothing for, so they are deliberately NOT added — the
-- authority is the postal operator, not the 2021 community scrape that listed
-- them. city = the API's Post_Office (post town); state / state_code = Melaka /
-- MLK, matching the existing Melaka rows.
--
-- Idempotent via WHERE NOT EXISTS on (postcode, city, state, country) — mig
-- 0181's pattern — so it is safe to re-run and coexists with the UNIQUE index
-- from 20260911T1730 whichever order the two land in.
--
-- REVERSAL: DELETE FROM scm.my_localities WHERE country = 'Malaysia'
--   AND state = 'Melaka' AND postcode IN ('75500','75502','75503','75504','75505','75506','75508','75510','75512','75514','75516','75517','75518','75519','75532','75536','75538','75540','75542','75546','75550','75551','75552','75560','75564','75566','75570','75572','75576','75578','75582','75584','75586','75590','75592','75594','75596','75600','75604','75606','75608','75609','75612','75620','75622','75626','75628','75630','75632','75646','75648','75670','75672','75673','75674','75676','75690','75700','75710','75720','75730','75740','75750','75760','75900','75902','75904','75906','75908','75910','75912','75914','75916','75918','75990','77309','77409');
-- Verified against: official Pos Malaysia API, 2026-09-11 (77/80 codes returned data).
-- ----------------------------------------------------------------------------

INSERT INTO scm.my_localities (postcode, city, state, state_code, country)
SELECT v.postcode, v.city, v.state, v.state_code, v.country
  FROM (VALUES
    ('75500', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75502', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75503', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75504', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75505', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75506', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75508', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75510', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75512', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75514', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75516', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75517', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75518', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75519', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75532', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75536', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75538', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75540', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75542', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75546', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75550', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75551', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75552', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75560', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75564', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75566', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75570', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75572', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75576', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75578', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75582', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75584', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75586', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75590', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75592', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75594', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75596', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75600', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75604', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75606', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75608', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75609', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75612', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75620', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75622', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75626', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75628', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75630', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75632', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75646', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75648', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75670', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75672', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75673', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75674', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75676', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75690', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75700', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75710', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75720', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75730', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75740', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75750', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75760', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75900', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75902', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75904', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75906', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75908', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75910', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75912', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75914', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75916', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75918', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('75990', 'Melaka', 'Melaka', 'MLK', 'Malaysia'),
    ('77309', 'Merlimau', 'Melaka', 'MLK', 'Malaysia'),
    ('77409', 'Sungai Rambai', 'Melaka', 'MLK', 'Malaysia')
  ) AS v(postcode, city, state, state_code, country)
 WHERE NOT EXISTS (
   SELECT 1 FROM scm.my_localities m
    WHERE m.postcode = v.postcode
      AND m.city     = v.city
      AND m.state    = v.state
      AND m.country  = v.country
 );
