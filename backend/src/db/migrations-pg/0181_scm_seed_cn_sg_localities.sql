-- 0181_scm_seed_cn_sg_localities.sql
--
-- Seed China + Singapore reference data into scm.my_localities so the
-- Country → State → City → Postcode cascade in every address form
-- (supplier / venue / warehouse / SO delivery) can pick foreign locations
-- from the SAME master the maintenance UI edits — not a per-form free-text
-- fallback and NOT the `(legacy)` sneak-through I built in #1054/#1058
-- (which lets any string live in the row without going through the
-- localities maintenance flow).
--
-- Owner directive 2026-07-23:
--   "把中国的 state 全部开出来先, 新加坡也是, 新加坡的 state 都把它开出来.
--    才从我们的 dropdown 维护那边去做选择, 而不是直接走后门."
--
-- SEEDED:
--   • CN — 34 provincial-level admin divisions (23 provinces + 5 autonomous
--     regions + 4 municipalities + 2 SARs (HK+Macau) + Taiwan). Major
--     economic provinces (Beijing / Shanghai / Guangdong / Jiangsu /
--     Zhejiang / Shandong / Sichuan / Fujian) get 2–4 major cities. Others
--     get their provincial capital. Postcode = the 6-digit CN 邮政编码
--     for that city (Guangzhou 510000, Beijing 100000, etc.). HK/Macau
--     use the standard 999077/999078 placeholder since neither has a
--     public postcode system.
--   • SG — 5 URA planning regions (Central / East / North / North-East /
--     West) split into 55 planning areas as `city`. Postcode = a
--     representative 6-digit SG postcode whose first 2 digits map to the
--     postal district that covers the planning area (e.g. Orchard → 09
--     Orchard/Cairnhill district → 238999).
--
-- BACKFILL:
--   Once the CN/SG rows exist, re-run the country back-derive on the four
--   address tables so any supplier / venue / warehouse row whose state
--   matches a newly-seeded CN or SG state gets its country filled without
--   the operator having to re-open the form. Idempotent — the COALESCE
--   only touches rows with NULL country.
--
-- IDEMPOTENCE:
--   Uses `INSERT ... SELECT ... WHERE NOT EXISTS` per row rather than
--   ON CONFLICT — scm.my_localities has no UNIQUE constraint beyond its
--   uuid PK, so ON CONFLICT has no target and CREATE UNIQUE INDEX would
--   fail on any pre-existing duplicate. NOT EXISTS re-runs cleanly and
--   also preserves any row the maintenance UI has added for one of these
--   seeded (postcode, city, state) triples.
--
-- Ref: #<PR>. Follows mig 0022 (MY seed), 0175 (state canonicalize),
-- 0180 (warehouse address).

BEGIN;

------------------------------------------------------------------
-- CHINA — 34 provincial-level administrative divisions
------------------------------------------------------------------

INSERT INTO scm.my_localities (postcode, city, state, state_code, country)
SELECT v.postcode, v.city, v.state, v.state_code, v.country
  FROM (VALUES
    -- Municipalities (直辖市)
    ('100000', 'Beijing',   'Beijing',   'BJ',  'China'),
    ('100081', 'Beijing',   'Beijing',   'BJ',  'China'),
    ('200000', 'Shanghai',  'Shanghai',  'SH',  'China'),
    ('200120', 'Shanghai',  'Shanghai',  'SH',  'China'),
    ('300000', 'Tianjin',   'Tianjin',   'TJ',  'China'),
    ('400000', 'Chongqing', 'Chongqing', 'CQ',  'China'),

    -- Guangdong (广东) — 6 major PRD cities
    ('510000', 'Guangzhou', 'Guangdong', 'GD',  'China'),
    ('518000', 'Shenzhen',  'Guangdong', 'GD',  'China'),
    ('519000', 'Zhuhai',    'Guangdong', 'GD',  'China'),
    ('528000', 'Foshan',    'Guangdong', 'GD',  'China'),
    ('523000', 'Dongguan',  'Guangdong', 'GD',  'China'),
    ('528400', 'Zhongshan', 'Guangdong', 'GD',  'China'),

    -- Jiangsu (江苏)
    ('210000', 'Nanjing',   'Jiangsu',   'JS',  'China'),
    ('215000', 'Suzhou',    'Jiangsu',   'JS',  'China'),
    ('214000', 'Wuxi',      'Jiangsu',   'JS',  'China'),
    ('213000', 'Changzhou', 'Jiangsu',   'JS',  'China'),

    -- Zhejiang (浙江)
    ('310000', 'Hangzhou',  'Zhejiang',  'ZJ',  'China'),
    ('315000', 'Ningbo',    'Zhejiang',  'ZJ',  'China'),
    ('325000', 'Wenzhou',   'Zhejiang',  'ZJ',  'China'),
    ('312000', 'Shaoxing',  'Zhejiang',  'ZJ',  'China'),

    -- Shandong (山东)
    ('250000', 'Jinan',     'Shandong',  'SD',  'China'),
    ('266000', 'Qingdao',   'Shandong',  'SD',  'China'),

    -- Fujian (福建)
    ('350000', 'Fuzhou',    'Fujian',    'FJ',  'China'),
    ('361000', 'Xiamen',    'Fujian',    'FJ',  'China'),

    -- Sichuan (四川)
    ('610000', 'Chengdu',   'Sichuan',   'SC',  'China'),
    ('621000', 'Mianyang',  'Sichuan',   'SC',  'China'),

    -- Other provinces (省会 only)
    ('230000', 'Hefei',       'Anhui',        'AH', 'China'),
    ('730000', 'Lanzhou',     'Gansu',        'GS', 'China'),
    ('550000', 'Guiyang',     'Guizhou',      'GZ', 'China'),
    ('570000', 'Haikou',      'Hainan',       'HI', 'China'),
    ('050000', 'Shijiazhuang','Hebei',        'HE', 'China'),
    ('150000', 'Harbin',      'Heilongjiang', 'HL', 'China'),
    ('450000', 'Zhengzhou',   'Henan',        'HA', 'China'),
    ('430000', 'Wuhan',       'Hubei',        'HB', 'China'),
    ('410000', 'Changsha',    'Hunan',        'HN', 'China'),
    ('330000', 'Nanchang',    'Jiangxi',      'JX', 'China'),
    ('130000', 'Changchun',   'Jilin',        'JL', 'China'),
    ('110000', 'Shenyang',    'Liaoning',     'LN', 'China'),
    ('810000', 'Xining',      'Qinghai',      'QH', 'China'),
    ('710000', 'Xi''an',      'Shaanxi',      'SN', 'China'),
    ('030000', 'Taiyuan',     'Shanxi',       'SX', 'China'),
    ('650000', 'Kunming',     'Yunnan',       'YN', 'China'),

    -- Autonomous regions (自治区)
    ('530000', 'Nanning',      'Guangxi',        'GX', 'China'),
    ('010000', 'Hohhot',       'Inner Mongolia', 'NM', 'China'),
    ('750000', 'Yinchuan',     'Ningxia',        'NX', 'China'),
    ('850000', 'Lhasa',        'Tibet',          'XZ', 'China'),
    ('830000', 'Urumqi',       'Xinjiang',       'XJ', 'China'),

    -- Special Administrative Regions
    ('999077', 'Hong Kong',    'Hong Kong',      'HK', 'China'),
    ('999078', 'Macau',        'Macau',          'MO', 'China'),

    -- Taiwan
    ('100',    'Taipei',       'Taiwan',         'TW', 'China'),
    ('400',    'Taichung',     'Taiwan',         'TW', 'China'),
    ('800',    'Kaohsiung',    'Taiwan',         'TW', 'China')
  ) AS v(postcode, city, state, state_code, country)
 WHERE NOT EXISTS (
   SELECT 1 FROM scm.my_localities m
    WHERE m.postcode = v.postcode
      AND m.city     = v.city
      AND m.state    = v.state
 );

------------------------------------------------------------------
-- SINGAPORE — 5 URA planning regions × 55 planning areas
------------------------------------------------------------------
--
-- Region assignment follows the URA Master Plan 2019. Postcode = a
-- representative 6-digit SG postcode whose first 2 digits map to the
-- postal district covering the planning area (e.g. Bishan → 20 → 570000).

INSERT INTO scm.my_localities (postcode, city, state, state_code, country)
SELECT v.postcode, v.city, v.state, v.state_code, v.country
  FROM (VALUES
    -- Central Region (22 planning areas)
    ('570000', 'Bishan',           'Central',    'C-SG', 'Singapore'),
    ('150000', 'Bukit Merah',      'Central',    'C-SG', 'Singapore'),
    ('260000', 'Bukit Timah',      'Central',    'C-SG', 'Singapore'),
    ('049999', 'Downtown Core',    'Central',    'C-SG', 'Singapore'),
    ('380000', 'Geylang',          'Central',    'C-SG', 'Singapore'),
    ('320000', 'Kallang',          'Central',    'C-SG', 'Singapore'),
    ('039999', 'Marina East',      'Central',    'C-SG', 'Singapore'),
    ('018999', 'Marina South',     'Central',    'C-SG', 'Singapore'),
    ('440000', 'Marine Parade',    'Central',    'C-SG', 'Singapore'),
    ('180000', 'Museum',           'Central',    'C-SG', 'Singapore'),
    ('228999', 'Newton',           'Central',    'C-SG', 'Singapore'),
    ('308999', 'Novena',           'Central',    'C-SG', 'Singapore'),
    ('238999', 'Orchard',          'Central',    'C-SG', 'Singapore'),
    ('160000', 'Outram',           'Central',    'C-SG', 'Singapore'),
    ('149999', 'Queenstown',       'Central',    'C-SG', 'Singapore'),
    ('247999', 'River Valley',     'Central',    'C-SG', 'Singapore'),
    ('190000', 'Rochor',           'Central',    'C-SG', 'Singapore'),
    ('058999', 'Singapore River',  'Central',    'C-SG', 'Singapore'),
    ('098999', 'Southern Islands', 'Central',    'C-SG', 'Singapore'),
    ('019999', 'Straits View',     'Central',    'C-SG', 'Singapore'),
    ('249999', 'Tanglin',          'Central',    'C-SG', 'Singapore'),
    ('310000', 'Toa Payoh',        'Central',    'C-SG', 'Singapore'),

    -- East Region (6)
    ('460000', 'Bedok',            'East',       'E-SG', 'Singapore'),
    ('499999', 'Changi',           'East',       'E-SG', 'Singapore'),
    ('498999', 'Changi Bay',       'East',       'E-SG', 'Singapore'),
    ('519999', 'Pasir Ris',        'East',       'E-SG', 'Singapore'),
    ('409999', 'Paya Lebar',       'East',       'E-SG', 'Singapore'),
    ('529999', 'Tampines',         'East',       'E-SG', 'Singapore'),

    -- North Region (8)
    ('779999', 'Central Water Catchment', 'North', 'N-SG', 'Singapore'),
    ('719999', 'Lim Chu Kang',     'North',      'N-SG', 'Singapore'),
    ('729999', 'Mandai',           'North',      'N-SG', 'Singapore'),
    ('750000', 'Sembawang',        'North',      'N-SG', 'Singapore'),
    ('799999', 'Simpang',          'North',      'N-SG', 'Singapore'),
    ('739999', 'Sungei Kadut',     'North',      'N-SG', 'Singapore'),
    ('730000', 'Woodlands',        'North',      'N-SG', 'Singapore'),
    ('760000', 'Yishun',           'North',      'N-SG', 'Singapore'),

    -- North-East Region (7)
    ('560000', 'Ang Mo Kio',       'North-East', 'NE-SG', 'Singapore'),
    ('530000', 'Hougang',          'North-East', 'NE-SG', 'Singapore'),
    ('509999', 'North-Eastern Islands', 'North-East', 'NE-SG', 'Singapore'),
    ('828999', 'Punggol',          'North-East', 'NE-SG', 'Singapore'),
    ('798999', 'Seletar',          'North-East', 'NE-SG', 'Singapore'),
    ('540000', 'Sengkang',         'North-East', 'NE-SG', 'Singapore'),
    ('550000', 'Serangoon',        'North-East', 'NE-SG', 'Singapore'),

    -- West Region (12)
    ('649999', 'Boon Lay',         'West',       'W-SG', 'Singapore'),
    ('650000', 'Bukit Batok',      'West',       'W-SG', 'Singapore'),
    ('670000', 'Bukit Panjang',    'West',       'W-SG', 'Singapore'),
    ('680000', 'Choa Chu Kang',    'West',       'W-SG', 'Singapore'),
    ('120000', 'Clementi',         'West',       'W-SG', 'Singapore'),
    ('600000', 'Jurong East',      'West',       'W-SG', 'Singapore'),
    ('640000', 'Jurong West',      'West',       'W-SG', 'Singapore'),
    ('629999', 'Pioneer',          'West',       'W-SG', 'Singapore'),
    ('699999', 'Tengah',           'West',       'W-SG', 'Singapore'),
    ('638999', 'Tuas',             'West',       'W-SG', 'Singapore'),
    ('098888', 'Western Islands',  'West',       'W-SG', 'Singapore'),
    ('698999', 'Western Water Catchment', 'West','W-SG', 'Singapore')
  ) AS v(postcode, city, state, state_code, country)
 WHERE NOT EXISTS (
   SELECT 1 FROM scm.my_localities m
    WHERE m.postcode = v.postcode
      AND m.city     = v.city
      AND m.state    = v.state
 );

------------------------------------------------------------------
-- BACKFILL — country from state on every address table
------------------------------------------------------------------
--
-- Now that CN + SG states are seeded, any supplier / venue / warehouse
-- row whose state matches a newly-seeded state gets its country filled
-- (was NULL before because the state wasn't in my_localities). Guarded
-- with information_schema.columns so a missing country column on any
-- table skips cleanly instead of aborting the migration (same class as
-- mig 0175 hotfix2 #1057).

DO $$
DECLARE
  t_full text;
  t_schema text;
  t_name text;
BEGIN
  FOR t_full IN SELECT unnest(ARRAY[
    'public.suppliers',
    'public.project_venues',
    'scm.warehouses'
  ]) LOOP
    t_schema := split_part(t_full, '.', 1);
    t_name   := split_part(t_full, '.', 2);
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = t_schema AND table_name = t_name AND column_name = 'country'
    ) AND EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = t_schema AND table_name = t_name AND column_name = 'state'
    ) THEN
      EXECUTE format($f$
        UPDATE %I.%I x
           SET country = COALESCE((
                 SELECT ml.country FROM scm.my_localities ml
                  WHERE ml.state = x.state
                  LIMIT 1
               ), x.country)
         WHERE x.country IS NULL
           AND x.state IS NOT NULL
      $f$, t_schema, t_name);
    END IF;
  END LOOP;
END $$;

COMMIT;
