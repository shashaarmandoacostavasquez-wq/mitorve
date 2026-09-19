from pathlib import Path
import re

src = Path("/mnt/data/server_the_real_packs.js")
dst = Path("/mnt/data/server_THE_REAL_FINAL_3_SABORES.js")

text = src.read_text(encoding="utf-8")

# 1) Add central configuration after static serving.
marker = "app.use(express.static(__dirname, { extensions: ['html'] }));\n"
config = r"""

// ==========================================
// CONFIGURACIÓN DE THE REAL
// ==========================================

const ALLOWED_PRODUCT_NAMES = [
  'Oreo Crunch',
  'Coco Real',
  'Pecana Real'
];

const ALLOWED_PRODUCT_SET =
  new Set(ALLOWED_PRODUCT_NAMES);

const PACK_PRICES = Object.freeze({
  4: 11,
  6: 15,
  8: 20,
  12: 27
});

const DELIVERY_FEES = Object.freeze({
  'Cercado de Lima': 10,
  'Breña': 10,
  'La Victoria': 10,
  'Lince': 10,
  'Jesús María': 10,
  'Rímac': 10,
  'Pueblo Libre': 12,
  'Magdalena': 12,
  'San Isidro': 12,
  'San Luis': 12,
  'San Miguel': 15,
  'Miraflores': 15,
  'Surquillo': 15,
  'San Borja': 15,
  'Santa Anita': 15,
  'El Agustino': 15,
  'Surco': 18,
  'San Martín de Porres': 18,
  'Independencia': 18,
  'Los Olivos': 20,
  'Ate': 20,
  'Chorrillos': 22,
  'Otro': 25
});

const ALLOWED_DELIVERY_METHODS =
  new Set(['Delivery', 'Recojo']);

const ALLOWED_PAYMENTS =
  new Set(['cash', 'yape', 'plin']);
"""
if config not in text:
    text = text.replace(marker, marker + config)

# 2) Products endpoint: only expose the current 3 flavors and remove accidental duplicate "orders".
old_products_query = """        .from('products')
        .select(
          'id,name,slug,category,description,price,image_url,active'
        )
        .eq('active', true)
        .order('name');"""
new_products_query = """        .from('products')
        .select(
          'id,name,slug,category,description,price,image_url,active'
        )
        .eq('active', true)
        .in('name', ALLOWED_PRODUCT_NAMES)
        .order('name');"""
text = text.replace(old_products_query, new_products_query)

text = text.replace("""    return res.json({
      products: data || [],
      orders: data || []
    });""", """    return res.json({
      products: data || []
    });""")

# 3) Fetch only the 3 allowed products when validating an order.
old_validation_query = """        .from('products')
        .select('id,name,price,active')
        .in('id', ids)
        .eq('active', true);"""
new_validation_query = """        .from('products')
        .select('id,name,price,active')
        .in('id', ids)
        .in('name', ALLOWED_PRODUCT_NAMES)
        .eq('active', true);"""
text = text.replace(old_validation_query, new_validation_query)

# 4) Replace pack-price block: strict presentations, no legacy fallback.
pattern_pack = re.compile(
    r"""      const presentation =\n        Number\(item\.presentation\);\n\n      const packPrices = \{\n        4: 11,\n        6: 15,\n        8: 20,\n        12: 27\n      \};\n\n      let unitPrice;\n\n      if \(packPrices\[presentation\]\) \{\n        if \(\n          quantity % presentation !== 0\n        \) \{\n          return res\.status\(400\)\.json\(\{\n            error: 'Cantidad incompatible con la presentación'\n          \}\);\n        \}\n\n        unitPrice =\n          Number\(\n            \(\n              packPrices\[presentation\] /\n              presentation\n            \)\.toFixed\(4\)\n          \);\n\n        subtotal \+=\n          packPrices\[presentation\] \*\n          \(quantity / presentation\);\n      \} else \{\n        // Compatibilidad con clientes antiguos\.\n        unitPrice =\n          Number\(product\.price\);\n\n        subtotal \+=\n          unitPrice \* quantity;\n      \}"""
)
replacement_pack = """      if (!ALLOWED_PRODUCT_SET.has(product.name)) {
        return res.status(400).json({
          error: 'Producto no disponible'
        });
      }

      const presentation =
        Number(item.presentation);

      if (!PACK_PRICES[presentation]) {
        return res.status(400).json({
          error: 'Presentación inválida'
        });
      }

      if (quantity % presentation !== 0) {
        return res.status(400).json({
          error: 'Cantidad incompatible con la presentación'
        });
      }

      const numberOfBoxes =
        quantity / presentation;

      if (
        !Number.isInteger(numberOfBoxes) ||
        numberOfBoxes < 1 ||
        numberOfBoxes > 4
      ) {
        return res.status(400).json({
          error: 'Cantidad de cajas inválida'
        });
      }

      const unitPrice =
        Number(
          (
            PACK_PRICES[presentation] /
            presentation
          ).toFixed(4)
        );

      subtotal +=
        PACK_PRICES[presentation] *
        numberOfBoxes;"""
text, n = pattern_pack.subn(replacement_pack, text)
if n != 1:
    raise RuntimeError(f"No se pudo reemplazar bloque de packs. Reemplazos: {n}")

# 5) Replace local delivery/payment constants with centralized strict validation.
pattern_delivery = re.compile(
    r"""   const deliveryFees = \{.*?const allowedPayments = \['cash', 'yape', 'plin'\];\n\nconst requestedPayment =\n  String\(body\.payment_method \|\| ''\)\.trim\(\)\.toLowerCase\(\);\n\nconst paymentMethod =\n  allowedPayments\.includes\(requestedPayment\)\n    \? requestedPayment\n    : 'cash';""",
    re.S
)
replacement_delivery = """    const deliveryMethod =
      String(body.delivery_method || '').trim();

    if (!ALLOWED_DELIVERY_METHODS.has(deliveryMethod)) {
      return res.status(400).json({
        error: 'Método de entrega inválido'
      });
    }

    const district =
      String(body.district || '').trim();

    let shipping = 0;

    if (deliveryMethod === 'Delivery') {
      if (
        !district ||
        DELIVERY_FEES[district] === undefined
      ) {
        return res.status(400).json({
          error: 'Distrito de delivery inválido'
        });
      }

      if (!address) {
        return res.status(400).json({
          error: 'Dirección de delivery requerida'
        });
      }

      shipping =
        DELIVERY_FEES[district];
    }

    const total =
      subtotal + shipping;

    const requestedPayment =
      String(body.payment_method || '')
        .trim()
        .toLowerCase();

    if (!ALLOWED_PAYMENTS.has(requestedPayment)) {
      return res.status(400).json({
        error: 'Método de pago inválido'
      });
    }

    const paymentMethod =
      requestedPayment;"""
text, n = pattern_delivery.subn(replacement_delivery, text)
if n != 1:
    raise RuntimeError(f"No se pudo reemplazar bloque delivery/pago. Reemplazos: {n}")

# 6) Make health endpoint useful and update log branding.
text = text.replace(
"""app.get('/health', (req, res) => {
  res.json({ ok: true });
});""",
"""app.get('/health', (req, res) => {
  res.json({
    ok: true,
    brand: 'THE REAL',
    products: ALLOWED_PRODUCT_NAMES,
    packs: PACK_PRICES
  });
});"""
)
text = text.replace("`MITORVE escuchando en ${port}`", "`THE REAL escuchando en ${port}`")

dst.write_text(text, encoding="utf-8")
print(f"Listo: {dst.name} — {dst.stat().st_size/1024:.1f} KB")
