// ==========================================
// MOTOR DE INGRESOS DETALLADO (incomeEngine.js)
// ==========================================
// Concepto clave: "firstPayDate" es la fecha de UN pago de nómina real (de referencia).
// Todas las catorcenas (pasadas y futuras) se calculan sumando/restando múltiplos de 14 días a esa fecha.

function daysBetween(a, b) { return Math.round((b - a) / 86400000); }
function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }

function round2(n) { return Number(n.toFixed(2)); }

// ¿Esta catorcena trae bono? Patrones soportados:
//   "monthly-first": primera catorcena de cada mes, según el calendario de la empresa.
//        Se asigna cada pago al mes de su lunes (fecha de pago - 4 días); si el mes cambia
//        respecto al pago anterior, esa catorcena lleva bono. Reproduce los 12 bonos del calendario 2026.
//   "alternate": una sí, una no (anclado a firstPayDate / firstPayHasBonus)
//   "every": todas las catorcenas
function monthKeyOfPay(d) { const m = addDays(d, -4); return m.getFullYear() * 12 + m.getMonth(); }

function isBonusPay(config, payDate, k) {
  if (!config.hasBonus) return false;
  const pattern = config.bonusPattern || 'monthly-first';
  if (pattern === 'every') return true;
  if (pattern === 'alternate') {
    const isEvenStep = ((k % 2) + 2) % 2 === 0;
    return isEvenStep === (config.firstPayHasBonus !== false);
  }
  return monthKeyOfPay(payDate) !== monthKeyOfPay(addDays(payDate, -14));
}

// Calcula el desglose neto de una catorcena, con el mismo esquema que el recibo de nómina:
//   Sueldo ordinario = salario diario x días pagados
//   ISR = ISR base (sin bono) + ISR adicional que genera el bono
//   IMSS = monto fijo por catorcena
//   Fondo de ahorro = % del sueldo ordinario (no del bono)
function calculateBiweeklyPaycheck(config, isBonusPeriod = false) {
  // Compatibilidad con configuraciones antiguas (porcentajes simples)
  if (config.isrBase === undefined) {
    const grossLegacy = config.dailySalary * 14;
    const tax = round2(grossLegacy * (config.taxRatePercent ?? 0.10));
    const fund = round2(grossLegacy * (config.savingsFundPercent ?? 0.05));
    const bonusLegacy = isBonusPeriod ? (config.biweeklyBonusAmount || 0) : 0;
    return {
      ordinaryPay: round2(grossLegacy), grossPay: round2(grossLegacy), isr: tax, imss: 0,
      taxDeduction: tax, savingsRetention: fund, bonus: bonusLegacy,
      netPayToDebit: round2(grossLegacy - tax - fund + bonusLegacy)
    };
  }

  const days = config.daysPaidPerPeriod ?? 14;
  const ordinaryPay = round2(config.dailySalary * days);
  const bonus = isBonusPeriod ? (config.biweeklyBonusAmount || 0) : 0;

  const isr = round2((config.isrBase ?? 0) + bonus * (config.isrBonusRate ?? 0));
  const imss = round2(config.imss ?? 0);
  const savingsRetention = round2(ordinaryPay * (config.savingsFundPercent ?? 0));

  return {
    ordinaryPay: ordinaryPay,
    grossPay: round2(ordinaryPay + bonus),
    isr: isr,
    imss: imss,
    taxDeduction: round2(isr + imss),
    savingsRetention: savingsRetention,
    bonus: bonus,
    netPayToDebit: round2(ordinaryPay + bonus - isr - imss - savingsRetention)
  };
}

// Periodo de nómina vigente para una fecha: [nómina anterior (o de hoy), próxima nómina)
// Sirve para medir presupuesto y ahorro "de nómina a nómina".
function getPayPeriod(incomeConfig, todayStr) {
  const seed = parseLocalDate(incomeConfig.firstPayDate);
  const today = parseLocalDate(todayStr);
  const k = Math.floor(daysBetween(seed, today) / 14);
  const prev = addDays(seed, k * 14);
  const next = addDays(seed, (k + 1) * 14);
  return {
    periodStart: formatDate(prev),      // día de cobro que abrió el periodo (inclusive)
    nextPayDate: formatDate(next),      // próxima nómina (el periodo termina el día anterior)
    daysToNextPay: Math.max(1, daysBetween(today, next))
  };
}

// Reemplaza la nómina proyectada por la nómina REAL registrada (misma fecha) y agrega
// pagos reales que no coincidan con ninguna fecha proyectada (dentro de [fromStr, toStr]).
// Así lo que realmente te depositaron queda "congelado" aunque cambies la configuración después.
function applyActualPayrolls(events, actualPayrolls, fromStr, toStr) {
  const actuals = actualPayrolls || [];
  if (actuals.length === 0) return events;
  const byDate = {};
  actuals.forEach(a => { if (!(a.date in byDate)) byDate[a.date] = a; });

  const merged = events.map(e => {
    const a = byDate[e.date];
    if (!a) return e;
    return { ...e, amount: Number(a.amount), isActual: true, title: `${e.title} (real)`, projectedAmount: e.amount };
  });

  const projectedDates = new Set(events.map(e => e.date));
  actuals.forEach(a => {
    if (projectedDates.has(a.date)) return;
    if (a.date < fromStr || a.date > toStr) return;
    merged.push({
      id: `income-actual-${a.date}`, title: 'Nómina recibida (real)', type: 'income', isPayroll: true,
      isActual: true, amount: Number(a.amount), date: a.date, category: 'Nómina Neta'
    });
  });
  return merged.sort((x, y) => x.date.localeCompare(y.date));
}

// Genera todas las catorcenas proyectadas en un rango de meses (impuestos, fondo de ahorro y bonos alternados)
function projectDetailedIncomes(incomeConfig, startYear, startMonth, monthsToProject = 6) {
  const events = [];
  const startObj = new Date(startYear, startMonth, 1);
  const endObj = new Date(startYear, startMonth + monthsToProject, 0);

  const seed = parseLocalDate(incomeConfig.firstPayDate);

  // k = número de catorcenas respecto a la fecha de referencia (puede ser negativo si la ventana es anterior)
  let k = Math.ceil(daysBetween(seed, startObj) / 14);
  let currentPayDate = addDays(seed, k * 14);

  while (currentPayDate <= endObj) {
    const dateStr = formatDate(currentPayDate);

    // El bono depende solo de la fecha (y de k en modo alterno), nunca de la ventana consultada
    const isBonusPeriod = isBonusPay(incomeConfig, currentPayDate, k);

    const calc = calculateBiweeklyPaycheck(incomeConfig, isBonusPeriod);

    // El fondo de ahorro (junio/diciembre) no es parte de la nómina: regístralo como ingreso extra cuando lo recibas.
    const titleSuffix = "Nómina Catorcenal";

    events.push({
      id: `income-bio-${dateStr}`,
      title: titleSuffix,
      type: "income",
      isPayroll: true,
      amount: calc.netPayToDebit,
      date: dateStr,
      category: "Nómina Neta",
      breakdown: calc
    });

    k++;
    currentPayDate = addDays(seed, k * 14);
  }

  return events;
}

// ==========================================
// PRUEBA EN CONSOLA (Para validar cálculos)
// ==========================================
const miConfiguracionNomina = {
  dailySalary: 533.33,       // Salario diario del recibo (ya incluye el factor de sábados)
  daysPaidPerPeriod: 14,
  isrBase: 746.16,           // ISR de una catorcena sin bono
  isrBonusRate: 0.2102,      // ISR adicional por cada $1 de bono
  imss: 287.87,
  savingsFundPercent: 0.13,  // % del sueldo ordinario
  hasBonus: true,
  biweeklyBonusAmount: 5000, // Bono conservador (el máximo real es 6,200)
  bonusPattern: "monthly-first", // Bono en la primera catorcena de cada mes (calendario de la empresa)
  firstPayDate: "2026-10-30", // Un día de cobro real (referencia, solo ancla el ciclo de 14 días)
  firstPayHasBonus: false
};

console.log("=== PROYECCIÓN DE INGRESOS DETALLADOS (PRÓXIMAS CATORCENAS) ===");
console.table(projectDetailedIncomes(miConfiguracionNomina, 2026, 9, 3));
