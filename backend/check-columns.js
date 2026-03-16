import pool from './src/config/db.js';

const query = `
  SELECT column_name, data_type 
  FROM information_schema.columns 
  WHERE table_name = 'employees' 
  ORDER BY ordinal_position
`;

pool.query(query)
  .then(result => {
    console.log(JSON.stringify(result.rows, null, 2));
    process.exit(0);
  })
  .catch(err => {
    console.error(err.message);
    process.exit(1);
  });
