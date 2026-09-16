require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');

const app = express();

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '100kb' }));
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false
}));
app.use(express.static(__dirname, { extensions: ['html'] }));


// ==========================================
// SUPABASE
// ==========================================

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseSecret = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseSecret) {
  console.error('Faltan SUPABASE_URL y/o SUPABASE_SERVICE_ROLE_KEY');
}

const clientOptions = {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
    detectSessionInUrl: false
  }
};

// Este cliente SOLO trabaja con la base de datos.
const db =
  supabaseUrl && supabaseSecret
    ? createClient(supabaseUrl, supabaseSecret, clientOptions)
    : null;

// Este cliente SOLO se usa para iniciar sesión.
const authClient =
  supabaseUrl && supabaseSecret
    ? createClient(supabaseUrl, supabaseSecret, clientOptions)
    : null;


function requireConfig(res) {
  if (!db || !authClient) {
    res.status(500).json({
      error: 'Servidor sin configurar'
    });
    return false;
  }

  return true;
}


// ==========================================
// VERIFICAR ADMIN
// ==========================================

async function requireAdmin(req, res, next) {
  if (!requireConfig(res)) return;

  try {
    const authorization = req.headers.authorization || '';

    const token = authorization.startsWith('Bearer ')
      ? authorization.slice(7)
      : '';

    if (!token) {
      return res.status(401).json({
        error: 'No autorizado'
      });
    }

    // Verificamos el JWT recibido sin iniciar
    // una sesión dentro del cliente DB.
    const { data: userData, error: userError } =
      await db.auth.getUser(token);

    if (userError || !userData?.user) {
      return res.status(401).json({
        error: 'Sesión inválida'
      });
    }

    const { data: admin, error: adminError } =
      await db
        .from('admin_users')
        .select('user_id')
        .eq('user_id', userData.user.id)
        .maybeSingle();

    if (adminError) {
      console.error('ADMIN CHECK ERROR:', adminError);

      return res.status(500).json({
        error: 'No se pudo verificar el administrador',
        details: adminError.message
      });
    }

    if (!admin) {
      return res.status(403).json({
        error: 'Acceso de administrador requerido'
      });
    }

    req.user = userData.user;
    next();

  } catch (error) {
    console.error('REQUIRE ADMIN ERROR:', error);

    return res.status(500).json({
      error: 'Error verificando la sesión',
      details: error.message
    });
  }
}


// ==========================================
// LOGIN ADMIN
// ==========================================

app.post('/api/admin/login', async (req, res) => {
  if (!requireConfig(res)) return;

  const email = String(req.body?.email || '').trim();
  const password = String(req.body?.password || '');

  if (!email || !password) {
    return res.status(400).json({
      error: 'Correo y contraseña requeridos'
    });
  }

  try {
    // IMPORTANTE:
    // El login ocurre en authClient, NO en db.
    const { data, error } =
      await authClient.auth.signInWithPassword({
        email,
        password
      });

    if (error || !data?.session || !data?.user) {
      return res.status(401).json({
        error: 'Correo o contraseña incorrectos'
      });
    }

    const { data: admin, error: adminError } =
      await db
        .from('admin_users')
        .select('user_id')
        .eq('user_id', data.user.id)
        .maybeSingle();

    if (adminError) {
      console.error('ADMIN LOGIN CHECK ERROR:', adminError);

      return res.status(500).json({
        error: 'No se pudo verificar el administrador',
        details: adminError.message
      });
    }

    if (!admin) {
      return res.status(403).json({
        error: 'Esta cuenta no es administrador'
      });
    }

    return res.json({
      access_token: data.session.access_token
    });

  } catch (error) {
    console.error('LOGIN ERROR:', error);

    return res.status(500).json({
      error: 'Error interno al iniciar sesión',
      details: error.message
    });
  }
});


// ==========================================
// PRODUCTOS
// ==========================================

app.get('/api/products', async (req, res) => {
  if (!requireConfig(res)) return;

  try {
    const { data, error } =
      await db
        .from('products')
        .select(
          'id,name,slug,category,description,price,image_url,active'
        )
        .eq('active', true)
        .order('name');

    if (error) {
      console.error('PRODUCTS ERROR:', error);

      return res.status(500).json({
        error: 'No se pudieron cargar los productos',
        details: error.message
      });
    }

    return res.json({
      products: data || [],
      orders: data || []
    });

  } catch (error) {
    console.error('PRODUCTS FATAL ERROR:', error);

    return res.status(500).json({
      error: 'Error interno al cargar productos',
      details: error.message
    });
  }
});


// ==========================================
// CREAR PEDIDO
// ==========================================

app.post('/api/orders', async (req, res) => {
  if (!requireConfig(res)) return;

  try {
    const body = req.body || {};

    const name =
      String(body.customer_name || '').trim();

    const phone =
      String(body.customer_phone || '').trim();

    const email =
      String(body.customer_email || '').trim();

    const address =
      String(
        body.delivery_address ||
        body.address ||
        ''
      ).trim();

    const notes =
      String(body.delivery_notes || '')
        .slice(0, 1000);

    const items =
      Array.isArray(body.items)
        ? body.items
        : [];

    if (
      name.length < 2 ||
      name.length > 100 ||
      phone.length < 7 ||
      phone.length > 30 ||
      items.length === 0
    ) {
      return res.status(400).json({
        error: 'Datos del pedido inválidos'
      });
    }

    if (items.length > 30) {
      return res.status(400).json({
        error: 'Demasiados productos'
      });
    }

    const ids = [
      ...new Set(
        items
          .map(item =>
            String(item.product_id || '')
          )
          .filter(Boolean)
      )
    ];

    const { data: products, error: productsError } =
      await db
        .from('products')
        .select('id,name,price,active')
        .in('id', ids)
        .eq('active', true);

    if (productsError) {
      console.error(
        'PRODUCT VALIDATION ERROR:',
        productsError
      );

      return res.status(500).json({
        error: 'No se pudieron validar los productos',
        details: productsError.message
      });
    }

    const productMap = new Map(
      (products || []).map(product => [
        String(product.id),
        product
      ])
    );

    let subtotal = 0;
    const safeItems = [];

    for (const item of items) {
      const product =
        productMap.get(
          String(item.product_id || '')
        );

      const quantity =
        Number(item.quantity);

      if (
        !product ||
        !Number.isInteger(quantity) ||
        quantity < 1 ||
        quantity > 50
      ) {
        return res.status(400).json({
          error: 'Producto o cantidad inválida'
        });
      }

      const unitPrice =
        Number(product.price);

      subtotal +=
        unitPrice * quantity;

      safeItems.push({
        product_id: product.id,
        product_name: product.name,
        unit_price: unitPrice,
        quantity,
        customization:
          String(item.customization || '')
            .slice(0, 500) || null
      });
    }

    const shipping = 0;
    const total = subtotal + shipping;

    const { data: order, error: orderError } =
      await db
        .from('orders')
        .insert({
          customer_name: name,
          customer_phone: phone,
          customer_email: email || null,
          delivery_address:
            address || 'A coordinar',
          delivery_notes:
            notes || null,
         payment_method: 'cash',
          subtotal,
          shipping_cost: shipping,
          total,
          status: 'pending'
        })
        .select(
          'id,total,created_at,status'
        )
        .single();

    if (orderError) {
      console.error(
        'CREATE ORDER ERROR:',
        orderError
      );

      return res.status(500).json({
        error: 'No se pudo guardar el pedido',
        details: orderError.message
      });
    }

    const rows =
      safeItems.map(item => ({
        ...item,
        order_id: order.id
      }));

    const { error: itemsError } =
      await db
        .from('order_items')
        .insert(rows);

    if (itemsError) {
      console.error(
        'CREATE ORDER ITEMS ERROR:',
        itemsError
      );

      // Elimina únicamente el pedido recién creado
      // si su detalle no pudo guardarse.
      const { error: rollbackError } =
        await db
          .from('orders')
          .delete()
          .eq('id', order.id);

      if (rollbackError) {
        console.error(
          'ROLLBACK ERROR:',
          rollbackError
        );
      }

      return res.status(500).json({
        error:
          'No se pudo guardar el detalle del pedido',
        details:
          itemsError.message
      });
    }

    return res.status(201).json({
      order
    });

  } catch (error) {
    console.error(
      'CREATE ORDER FATAL ERROR:',
      error
    );

    return res.status(500).json({
      error: 'Error interno al crear el pedido',
      details: error.message
    });
  }
});


// ==========================================
// PEDIDOS DEL ADMIN
// ==========================================

app.get(
  '/api/admin/orders',
  requireAdmin,
  async (req, res) => {

    if (!requireConfig(res)) return;

    try {
      // Consulta directa a ORDERS.
      const { data: orders, error: ordersError } =
        await db
          .from('orders')
          .select('*')
          .order(
            'created_at',
            { ascending: false }
          )
          .limit(200);

      if (ordersError) {
        console.error(
          'ORDERS ERROR:',
          ordersError
        );

        return res.status(500).json({
          error: 'No se pudieron cargar los pedidos',
          details: ordersError.message
        });
      }

      console.log(
        'ADMIN ORDERS:',
        orders?.length || 0
      );

      if (!orders || orders.length === 0) {
        return res.json([]);
      }

      // Ahora cargamos order_items por separado.
      const orderIds =
        orders.map(order => order.id);

      const { data: items, error: itemsError } =
        await db
          .from('order_items')
          .select('*')
          .in('order_id', orderIds);

      if (itemsError) {
        console.error(
          'ADMIN ORDER ITEMS ERROR:',
          itemsError
        );

        return res.status(500).json({
          error:
            'No se pudieron cargar los productos de los pedidos',
          details:
            itemsError.message
        });
      }

      const itemsByOrder = new Map();

      for (const item of items || []) {
        const key =
          String(item.order_id);

        if (!itemsByOrder.has(key)) {
          itemsByOrder.set(key, []);
        }

        itemsByOrder
          .get(key)
          .push(item);
      }

      const result =
        orders.map(order => ({
          ...order,

          order_items:
            itemsByOrder.get(
              String(order.id)
            ) || []
        }));

      console.log(
        'ADMIN RESPONSE:',
        {
          orders: result.length,
          items: (items || []).length
        }
      );

      return res.json(result);

    } catch (error) {
      console.error(
        'ADMIN ORDERS FATAL ERROR:',
        error
      );

      return res.status(500).json({
        error: 'Error interno al cargar pedidos',
        details: error.message
      });
    }
  }
);


// ==========================================
// CAMBIAR ESTADO
// ==========================================

app.patch(
  '/api/admin/orders/:id',
  requireAdmin,
  async (req, res) => {

    if (!requireConfig(res)) return;

    const allowed = [
      'pending',
      'confirmed',
      'preparing',
      'ready',
      'delivered',
      'cancelled'
    ];

    const status =
      String(req.body?.status || '');

    if (!allowed.includes(status)) {
      return res.status(400).json({
        error: 'Estado inválido'
      });
    }

    try {
      const { data, error } =
        await db
          .from('orders')
          .update({ status })
          .eq('id', req.params.id)
          .select()
          .single();

      if (error) {
        console.error(
          'UPDATE ORDER ERROR:',
          error
        );

        return res.status(500).json({
          error:
            'No se pudo actualizar el pedido',
          details: error.message
        });
      }

      return res.json(data);

    } catch (error) {
      console.error(
        'UPDATE ORDER FATAL ERROR:',
        error
      );

      return res.status(500).json({
        error:
          'Error interno al actualizar el pedido',
        details: error.message
      });
    }
  }
);


// ==========================================
// ESTADO DEL PEDIDO PARA EL CLIENTE
// ==========================================

app.get(
  '/api/orders/:id/status',
  async (req, res) => {

    if (!requireConfig(res)) return;

    try {
      const { data, error } =
        await db
          .from('orders')
          .select(
            'id,status,created_at,updated_at'
          )
          .eq('id', req.params.id)
          .maybeSingle();

      if (error) {
        console.error(
          'ORDER STATUS ERROR:',
          error
        );

        return res.status(500).json({
          error:
            'No se pudo consultar el pedido',
          details: error.message
        });
      }

      if (!data) {
        return res.status(404).json({
          error: 'Pedido no encontrado'
        });
      }

      return res.json(data);

    } catch (error) {
      console.error(
        'ORDER STATUS FATAL ERROR:',
        error
      );

      return res.status(500).json({
        error:
          'Error interno al consultar el pedido',
        details: error.message
      });
    }
  }
);


// ==========================================
// HEALTH
// ==========================================

app.get('/health', (req, res) => {
  res.json({ ok: true });
});


// ==========================================
// INICIAR SERVIDOR
// ==========================================

const port =
  Number(process.env.PORT || 3000);

app.listen(
  port,
  '0.0.0.0',
  () => {
    console.log(
      `MITORVE escuchando en ${port}`
    );
  }
);
