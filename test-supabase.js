const supabase = require('./config/supabase');

async function testConnection() {
    const { data, error } = await supabase
        .from('batches')
        .select('id')
        .limit(1);

    if (error) {
        console.error('Connection failed:', error.message);
        return;
    }

    console.log('SUCCESS! Supabase connected.');
    console.log('Database response:', data);
}

testConnection();