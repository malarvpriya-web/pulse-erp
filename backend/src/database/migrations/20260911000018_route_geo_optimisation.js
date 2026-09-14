/**
 * Coordinates, so route planning can optimise by distance rather than by date.
 *
 * The first build sequenced stops by promised date and priority, and said so:
 * without distances, delivering in the order things were promised is the only
 * defensible rule. That was honest but incomplete — it is a dispatch order, not
 * a route.
 *
 * WHAT NEEDED AN EXTERNAL SERVICE, AND WHAT DID NOT
 * -------------------------------------------------
 * Two different things were being conflated:
 *
 *   GEOCODING an address to a coordinate genuinely needs a service, or a human,
 *     or a lookup table. A city-level table covers most Indian industrial
 *     delivery planning and is seeded here.
 *
 *   OPTIMISING a tour over known coordinates is ordinary computer science:
 *     nearest-neighbour construction followed by 2-opt improvement. No API.
 *
 * So coordinates are stored on the stop, resolvable from a city reference table
 * or supplied directly, and the optimiser runs on whatever it has.
 *
 * DISTANCE IS GREAT-CIRCLE, NOT ROAD DISTANCE, and the API says so on every
 * response. A road-network or traffic matrix would improve the numbers and is a
 * substitution into the same optimiser — `distance_source` on the route records
 * which was used, so a later upgrade is visible in the data rather than silently
 * changing what past routes meant.
 */

export async function up(knex) {
  await knex.raw(`ALTER TABLE route_stops ADD COLUMN IF NOT EXISTS latitude       NUMERIC(10,6)`);
  await knex.raw(`ALTER TABLE route_stops ADD COLUMN IF NOT EXISTS longitude      NUMERIC(10,6)`);
  await knex.raw(`ALTER TABLE route_stops ADD COLUMN IF NOT EXISTS leg_distance_km NUMERIC(10,2)`);

  await knex.raw(`ALTER TABLE delivery_routes ADD COLUMN IF NOT EXISTS total_distance_km NUMERIC(10,2)`);
  await knex.raw(`ALTER TABLE delivery_routes ADD COLUMN IF NOT EXISTS distance_source   VARCHAR(24)`);
  await knex.raw(`ALTER TABLE delivery_routes ADD COLUMN IF NOT EXISTS optimised_at      TIMESTAMPTZ`);
  await knex.raw(`ALTER TABLE delivery_routes ADD COLUMN IF NOT EXISTS origin_lat        NUMERIC(10,6)`);
  await knex.raw(`ALTER TABLE delivery_routes ADD COLUMN IF NOT EXISTS origin_lng        NUMERIC(10,6)`);

  // A dispatching warehouse is the origin of a route.
  await knex.raw(`ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS latitude  NUMERIC(10,6)`);
  await knex.raw(`ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS longitude NUMERIC(10,6)`);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS geo_locations (
      id          SERIAL PRIMARY KEY,
      company_id  INTEGER,
      city        VARCHAR(120) NOT NULL,
      state       VARCHAR(120),
      country     VARCHAR(80) DEFAULT 'India',
      latitude    NUMERIC(10,6) NOT NULL,
      longitude   NUMERIC(10,6) NOT NULL,
      source      VARCHAR(24) DEFAULT 'reference',
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )`);
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS uq_geo_city ON geo_locations(LOWER(city), COALESCE(company_id, 0))`);

  // City coordinates for the places an Indian panel builder ships to. Reference
  // data, not fabricated transactions: these are the actual coordinates of real
  // cities, and they are marked `reference` so a later geocoding pass can
  // distinguish them from addresses somebody resolved properly.
  const cities = [
    ['Mumbai', 'Maharashtra', 19.076090, 72.877426],
    ['Pune', 'Maharashtra', 18.520430, 73.856744],
    ['Nashik', 'Maharashtra', 19.997454, 73.789803],
    ['Nagpur', 'Maharashtra', 21.145800, 79.088155],
    ['Ahmedabad', 'Gujarat', 23.022505, 72.571362],
    ['Surat', 'Gujarat', 21.170240, 72.831061],
    ['Vadodara', 'Gujarat', 22.307159, 73.181219],
    ['Delhi', 'Delhi', 28.613939, 77.209021],
    ['Gurugram', 'Haryana', 28.459497, 77.026638],
    ['Noida', 'Uttar Pradesh', 28.535517, 77.391029],
    ['Jaipur', 'Rajasthan', 26.912434, 75.787270],
    ['Lucknow', 'Uttar Pradesh', 26.846695, 80.946167],
    ['Kanpur', 'Uttar Pradesh', 26.449923, 80.331874],
    ['Bhopal', 'Madhya Pradesh', 23.259933, 77.412615],
    ['Indore', 'Madhya Pradesh', 22.719568, 75.857727],
    ['Bengaluru', 'Karnataka', 12.971599, 77.594566],
    ['Mysuru', 'Karnataka', 12.295810, 76.639381],
    ['Hubballi', 'Karnataka', 15.364700, 75.123955],
    ['Chennai', 'Tamil Nadu', 13.082680, 80.270721],
    ['Coimbatore', 'Tamil Nadu', 11.016844, 76.955832],
    ['Madurai', 'Tamil Nadu', 9.925201, 78.119775],
    ['Hyderabad', 'Telangana', 17.385044, 78.486671],
    ['Visakhapatnam', 'Andhra Pradesh', 17.686815, 83.218483],
    ['Vijayawada', 'Andhra Pradesh', 16.506174, 80.648015],
    ['Kochi', 'Kerala', 9.931233, 76.267303],
    ['Thiruvananthapuram', 'Kerala', 8.524139, 76.936638],
    ['Kolkata', 'West Bengal', 22.572646, 88.363895],
    ['Bhubaneswar', 'Odisha', 20.296059, 85.824539],
    ['Raipur', 'Chhattisgarh', 21.251384, 81.629641],
    ['Patna', 'Bihar', 25.594095, 85.137566],
    ['Ranchi', 'Jharkhand', 23.344101, 85.309562],
    ['Guwahati', 'Assam', 26.144518, 91.736237],
    ['Chandigarh', 'Chandigarh', 30.733315, 76.779419],
    ['Ludhiana', 'Punjab', 30.900965, 75.857276],
  ];
  for (const [city, state, lat, lng] of cities) {
    // $n, never ? — the migration runner is a pg shim, not real knex.
    await knex.raw(
      `INSERT INTO geo_locations (city, state, latitude, longitude, source)
       VALUES ($1, $2, $3, $4, 'reference')
       ON CONFLICT (LOWER(city), COALESCE(company_id, 0)) DO NOTHING`,
      [city, state, lat, lng]);
  }

  // The reference dataset's dispatching warehouse sits in Mumbai.
  await knex.raw(`
    UPDATE warehouses SET latitude = 19.076090, longitude = 72.877426
     WHERE latitude IS NULL
       AND (LOWER(COALESCE(warehouse_name, name, '')) LIKE '%mumbai%'
            OR LOWER(COALESCE(type, '')) = 'main')`);
}

export async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS geo_locations`);
  for (const c of ['longitude', 'latitude']) {
    await knex.raw(`ALTER TABLE warehouses DROP COLUMN IF EXISTS ${c}`);
  }
  for (const c of ['origin_lng', 'origin_lat', 'optimised_at', 'distance_source', 'total_distance_km']) {
    await knex.raw(`ALTER TABLE delivery_routes DROP COLUMN IF EXISTS ${c}`);
  }
  for (const c of ['leg_distance_km', 'longitude', 'latitude']) {
    await knex.raw(`ALTER TABLE route_stops DROP COLUMN IF EXISTS ${c}`);
  }
}
