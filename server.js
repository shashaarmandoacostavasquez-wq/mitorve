require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '100kb' }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false }));
app.use(express.static(__dirname, { extensions: ['html'] }));

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error('Faltan SUPABASE_URL y/o SUPABASE_SERVICE_ROLE_KEY');
}
const adminClient = url && serviceKey ? createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } }) : null;

function requireConfig(res) {
  if (!adminClient) { res.status(500).json({ error: 'Servidor sin configurar' }); return false; }
  return true;
}

async function requireAdmin(req, res, next) {
  if (!requireConfig(res)) return;
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return res.status(401).json({ error: 'No autorizado' });
  const { data: userData, error: userError } = await adminClient.auth.getUser(token);
  if (userError || !userData?.user) return res.status(401).json({ error: 'Sesión inválida' });
  const { data: admin, error: adminError } = await adminClient
    .from('admin_users').select('user_id').eq('user_id', userData.user.id).maybeSingle();
  if (adminError || !admin) return res.status(403).json({ error: 'Acceso de administrador requerido' });
  req.user = userData.user;
  next();
} app.post('/api/admin/login', async (req, res) => {
  if (!requireConfig(res)) return;

  const email = String(req.body?.email || '').trim();
  const password = String(req.body?.password || '');

  if (!email || !password) {
    return res.status(400).json({ error: 'Correo y contraseña requeridos' });
  }

  const { data, error } = await adminClient.auth.signInWithPassword({
    email,
    password
  });

  if (error || !data?.session || !data?.user) {
    return res.status(401).json({ error: 'Correo o contraseña incorrectos' });
  }

  const { data: admin, error: adminError } = await adminClient
    .from('admin_users')
    .select('user_id')
    .eq('user_id', data.user.id)
    .maybeSingle();
console.log('ADMIN CHECK:', { userId: data.user.id, admin, adminError });
  if (adminError || !admin) {
    return res.status(403).json({ error: 'Esta cuenta no es administrador' });
  }

  res.json({
    access_token: data.session.access_token
  });
});

app.get('/api/products', async (req, res) => {
  if (!requireConfig(res)) return;
  const { data, error } = await adminClient.from('products').select('id,name,slug,category,description,price,image_url,active').eq('active', true).order('name');
  if (error) return res.status(500).json({ error: 'No se pudieron cargar los productos' });
  res.json(data || []);
});

app.post('/api/orders', async (req, res) => {
  if (!requireConfig(res)) return;
  const b = req.body || {};
  const name = String(b.customer_name || '').trim();
  const phone = String(b.customer_phone || '').trim();
  const address = String(b.delivery_address || '').trim();
  const items = Array.isArray(b.items) ? b.items : [];
  if (name.length < 2 || name.length > 100 || phone.length < 7 || phone.length > 30 || !items.length) return res.status(400).json({ error: 'Datos del pedido inválidos' });
  if (items.length > 30) return res.status(400).json({ error: 'Demasiados productos' });

  const ids = items.map(x => String(x.product_id || '')).filter(Boolean);
  const { data: products, error: pErr } = await adminClient.from('products').select('id,name,price,active').in('id', ids).eq('active', true);
  if (pErr) return res.status(500).json({ error: 'No se pudieron validar los productos' });
  const byId = new Map((products || []).map(p => [p.id, p]));
  let subtotal = 0;
  const safeItems = [];
  for (const x of items) {
    const p = byId.get(String(x.product_id || ''));
    const qty = Number(x.quantity);
    if (!p || !Number.isInteger(qty) || qty < 1 || qty > 50) return res.status(400).json({ error: 'Producto o cantidad inválida' });
    subtotal += Number(p.price) * qty;
    safeItems.push({ product_id: p.id, product_name: p.name, unit_price: Number(p.price), quantity: qty, customization: String(x.customization || '').slice(0,500) || null });
  }
  const shipping = 0;
  const total = subtotal + shipping;
  const { data: order, error: oErr } = await adminClient.from('orders').insert({ customer_name: name, customer_phone: phone, customer_email: String(b.customer_email || '').trim() || null, delivery_address: address || 'A coordinar', delivery_notes: String(b.delivery_notes || '').slice(0,1000) || null, payment_method: 'cash', subtotal, shipping_cost: shipping, total }).select('id,total,created_at').single();
if (oErr) {
  console.error('CREATE ORDER ERROR:', oErr);
  return res.status(500).json({
    error: 'No se pudo guardar el pedido',
    details: oErr.message
  });
}
  const rows = safeItems.map(i => ({ ...i, order_id: order.id }));
  const { error: iErr } = await adminClient.from('order_items').insert(rows);
  if (iErr) { await adminClient.from('orders').delete().eq('id', order.id); return res.status(500).json({ error: 'No se pudo guardar el detalle del pedido' }); }
  res.status(201).json({ order });
});

app.get('/api/admin/orders', requireAdmin, async (req, res) => {
  const { data, error } = await adminClient.from('orders').select('*,order_items(*)').order('created_at', { ascending: false }).limit(200);
  if (error) {
  console.error('ORDERS ERROR:', error);
  return res.status(500).json({
    error: 'No se pudieron cargar los pedidos',
    details: error.message
  });
}

res.json(data || []);
});

app.patch('/api/admin/orders/:id', requireAdmin, async (req, res) => {
  const allowed = ['pending','confirmed','preparing','ready','delivered','cancelled'];
  const status = String(req.body?.status || '');
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Estado inválido' });
  const { data, error } = await adminClient.from('orders').update({ status }).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: 'No se pudo actualizar el pedido' });
  res.json(data);
});

app.get('/health', (req,res)=>res.json({ok:true}));
const port = Number(process.env.PORT || 3000);
app.listen(port, '0.0.0.0', ()=>console.log(`MITORVE escuchando en ${port}`));
