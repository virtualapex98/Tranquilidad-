// ==========================================
// 1. UTILIDADES DE FECHAS LOCALES
// ==========================================

function parseLocalDate(dateString) {
  const [year, month, day] = dateString.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function createSafeDate(year, monthIndex, targetDay) {
  const maxDaysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  const actualDay = Math.min(targetDay, maxDaysInMonth);
  return new Date(year, monthIndex, actualDay);
}

function formatDate(dateObj) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ==========================================
// 2A. MOTOR DE CICLOS, CORTES Y MSI
// ==========================================

function getFirstBillingCycle(purchaseDateStr, card) {
  const purchaseDate = parseLocalDate(purchaseDateStr);
  const pYear = purchaseDate.getFullYear();
  const pMonth = purchaseDate.getMonth();
  const pDay = purchaseDate.getDate();

  let cutoffMonth = pMonth;
  let cutoffYear = pYear;

  // Regla del día de corte (por tarjeta). La fecha que se usa es la FECHA DE CARGO del estado de cuenta
  // (no la de la operación, que puede ser 1-2 días anterior).
  //  - Por defecto (cutoffStartsNewPeriod no es true): el día de corte es el ÚLTIMO día del periodo; una compra
  //    con fecha de cargo igual al día de corte entra al estado que cierra ese día. Es lo que muestran los
  //    estados de Santander y Banamex (los cargos a meses se registran con la fecha de corte).
  //  - cutoffStartsNewPeriod === true: el día de corte es el PRIMER día del periodo nuevo.
  // En meses más cortos que el día de corte (por ejemplo corte 31 en abril) el corte real es el último día del mes.
  const startsNewPeriod = card.cutoffStartsNewPeriod === true;
  const daysInPurchaseMonth = new Date(pYear, pMonth + 1, 0).getDate();
  const effectiveCutoff = Math.min(card.cutoffDay, daysInPurchaseMonth);
  const crossesCutoff = startsNewPeriod ? pDay >= effectiveCutoff : pDay > effectiveCutoff;
  if (crossesCutoff) {
    cutoffMonth += 1;
  }

  let paymentMonth = cutoffMonth;
  let paymentYear = cutoffYear;

  if (card.paymentDueDay <= card.cutoffDay) {
    paymentMonth += 1;
  }

  return {
    firstCutoffYear: cutoffYear,
    firstCutoffMonth: cutoffMonth,
    firstPaymentYear: paymentYear,
    firstPaymentMonth: paymentMonth
  };
}

function generateInstallments(purchase, card) {
  const cycle = getFirstBillingCycle(purchase.date, card);
  const installments = [];
  
  const totalMonths = purchase.monthsMsi || 1;
  const baseAmount = Math.floor((purchase.totalAmount / totalMonths) * 100) / 100;
  const remainder = Number((purchase.totalAmount - (baseAmount * totalMonths)).toFixed(2));

  for (let i = 0; i < totalMonths; i++) {
    const cutoffDate = createSafeDate(
      cycle.firstCutoffYear,
      cycle.firstCutoffMonth + i,
      card.cutoffDay
    );

    const paymentDate = createSafeDate(
      cycle.firstPaymentYear,
      cycle.firstPaymentMonth + i,
      card.paymentDueDay
    );

    const isLast = (i === totalMonths - 1);
    const installmentAmount = isLast ? Number((baseAmount + remainder).toFixed(2)) : baseAmount;

    installments.push({
      type: "purchase",
      sourceId: purchase.id,
      cardId: card.id,
      cardName: card.name,
      description: purchase.description,
      installmentNumber: i + 1,
      totalInstallments: totalMonths,
      label: totalMonths > 1 ? `${purchase.description} (${i + 1}/${totalMonths})` : purchase.description,
      amount: installmentAmount,
      cutoffDate: formatDate(cutoffDate),
      paymentDueDate: formatDate(paymentDate)
    });
  }

  return installments;
}

// ==========================================
// 2B. PROYECTOR DE SUSCRIPCIONES (CON HISTORIAL Y FECHA DE CANCELACIÓN)
// ==========================================

function generateSubscriptionCharges(subscription, card, monthsToProject = 12) {
  const startDate = parseLocalDate(subscription.startDate);
  const startYear = startDate.getFullYear();
  const startMonth = startDate.getMonth();
  const charges = [];

  for (let i = 0; i < monthsToProject; i++) {
    const chargeDateObj = createSafeDate(startYear, startMonth + i, subscription.chargeDay);
    const chargeDateStr = formatDate(chargeDateObj);

    // 1. Si el día de cobro del primer mes es anterior a la fecha en que te suscribiste, se salta ese mes
    if (chargeDateStr < subscription.startDate) {
      continue;
    }

    // 2. Si tiene fecha de cancelación (endDate) y el cobro ya supera esa fecha, detenemos los cobros futuros
    if (subscription.endDate && chargeDateStr > subscription.endDate) {
      break;
    }

    const cycle = getFirstBillingCycle(chargeDateStr, card);
    const cutoffDate = createSafeDate(cycle.firstCutoffYear, cycle.firstCutoffMonth, card.cutoffDay);
    const paymentDate = createSafeDate(cycle.firstPaymentYear, cycle.firstPaymentMonth, card.paymentDueDay);

    charges.push({
      type: "subscription",
      sourceId: subscription.id,
      cardId: card.id,
      cardName: card.name,
      description: subscription.description,
      chargeDate: chargeDateStr,
      label: `${subscription.description} (Suscripción)`,
      amount: subscription.amount,
      cutoffDate: formatDate(cutoffDate),
      paymentDueDate: formatDate(paymentDate)
    });
  }

  return charges;
}

// ==========================================
// 2C. AGRUPADOR CON PAGOS PARCIALES E INTERESES REVOLVENTES
// ==========================================

function getCardStatements(purchases, subscriptions, card, paymentsHistory = [], monthsToProject = 12, todayStr = "2026-10-16") {
  const purchaseInstallments = purchases
    .filter(p => p.cardId === card.id)
    .flatMap(p => generateInstallments(p, card));

  // Ahora procesamos todas las suscripciones de la tarjeta (incluso las canceladas para conservar su historial pasado)
  const subscriptionCharges = subscriptions
    .filter(s => s.cardId === card.id)
    .flatMap(s => generateSubscriptionCharges(s, card, monthsToProject));

  const allItems = [...purchaseInstallments, ...subscriptionCharges];
  const statementsMap = {};

  for (const item of allItems) {
    const dueKey = item.paymentDueDate;
    if (!statementsMap[dueKey]) {
      statementsMap[dueKey] = {
        cardId: card.id,
        cardName: card.name,
        cutoffDate: item.cutoffDate,
        paymentDueDate: item.paymentDueDate,
        newCharges: 0,
        previousDebt: 0,
        interestAndTax: 0,
        totalToPay: 0,
        amountPaid: 0,
        remainingBalance: 0,
        status: "PENDIENTE",
        items: []
      };
    }
    statementsMap[dueKey].newCharges = Number((statementsMap[dueKey].newCharges + item.amount).toFixed(2));
    statementsMap[dueKey].items.push(item);
  }

  const sortedStatements = Object.values(statementsMap).sort((a, b) => 
    a.paymentDueDate.localeCompare(b.paymentDueDate)
  );

  let carriedOverDebt = 0;
  const monthlyRate = (card.annualInterestRate || 0.60) / 12;

  for (const st of sortedStatements) {
    if (carriedOverDebt > 0) {
      const interest = carriedOverDebt * monthlyRate;
      const iva = interest * 0.16;
      st.previousDebt = carriedOverDebt;
      st.interestAndTax = Number((interest + iva).toFixed(2));
    }

    st.totalToPay = Number((st.newCharges + st.previousDebt + st.interestAndTax).toFixed(2));

    const paidRecord = paymentsHistory
      .filter(p => p.cardId === card.id && p.paymentDueDate === st.paymentDueDate)
      .reduce((sum, p) => sum + p.amountPaid, 0);

    st.amountPaid = Number(paidRecord.toFixed(2));
    st.remainingBalance = Math.max(0, Number((st.totalToPay - st.amountPaid).toFixed(2)));

    if (st.remainingBalance === 0) {
      st.status = "PAGADO";
      carriedOverDebt = 0;
    } else if (st.amountPaid > 0 && st.remainingBalance > 0) {
      st.status = "PAGO PARCIAL (GENERA INTERÉS)";
      carriedOverDebt = st.remainingBalance;
    } else if (st.paymentDueDate < todayStr) {
      st.status = "VENCIDO (GENERA INTERÉS)";
      carriedOverDebt = st.remainingBalance;
    } else {
      st.status = "PENDIENTE";
      carriedOverDebt = 0; 
    }
  }

  return sortedStatements;
}

// ==========================================
// 2D. RESUMEN DE CRÉDITO DISPONIBLE REAL
// ==========================================

function getCardCreditSummary(card, purchases, subscriptions, paymentsHistory = [], asOfDateStr) {
  const totalPurchasesCommitted = purchases
    .filter(p => p.cardId === card.id && p.date <= asOfDateStr)
    .reduce((sum, p) => sum + p.totalAmount, 0);

  // Sumamos las suscripciones cobradas hasta hoy (generateSubscriptionCharges ya respeta endDate si fue cancelada)
  const totalSubscriptionsCharged = subscriptions
    .filter(s => s.cardId === card.id)
    .flatMap(s => generateSubscriptionCharges(s, card, 24))
    .filter(charge => charge.chargeDate <= asOfDateStr)
    .reduce((sum, charge) => sum + charge.amount, 0);

  const statements = getCardStatements(purchases, subscriptions, card, paymentsHistory, 24, asOfDateStr);
  
  const totalInterestsCharged = statements
    .filter(st => st.cutoffDate <= asOfDateStr || st.previousDebt > 0)
    .reduce((sum, st) => sum + st.interestAndTax, 0);

  const totalPaymentsMade = paymentsHistory
    .filter(p => p.cardId === card.id)
    .reduce((sum, p) => sum + p.amountPaid, 0);

  const usedCredit = Math.max(0, Number(((totalPurchasesCommitted + totalSubscriptionsCharged + totalInterestsCharged) - totalPaymentsMade).toFixed(2)));
  const availableCredit = Number((card.creditLimit - usedCredit).toFixed(2));
  const usagePercentage = Number(((usedCredit / card.creditLimit) * 100).toFixed(1));

  return {
    cardName: card.name,
    asOfDate: asOfDateStr,
    creditLimit: card.creditLimit,
    usedCredit: usedCredit,
    availableCredit: availableCredit,
    usagePercentage: `${usagePercentage}%`
  };
}

// ==========================================
// 3. PRUEBA DE EJECUCIÓN CON HISTORIAL Y MÚLTIPLES TARJETAS
// ==========================================

const misTarjetas = [
  {
    id: "card-bbva",
    name: "BBVA Azul",
    creditLimit: 20000,
    cutoffDay: 8,
    paymentDueDay: 28,
    annualInterestRate: 0.65
  },
  {
    id: "card-nu",
    name: "Tarjeta Nu",
    creditLimit: 12000,
    cutoffDay: 15,
    paymentDueDay: 5, // Corta el 15 y se paga el 5 del mes siguiente
    annualInterestRate: 0.58
  }
];

const misCompras = [
  { id: "p1", cardId: "card-bbva", description: "Despensa quincenal", totalAmount: 1850.50, date: "2026-10-05", monthsMsi: 1 },
  { id: "p2", cardId: "card-bbva", description: "Llantas nuevas",     totalAmount: 8500.00, date: "2026-10-12", monthsMsi: 6 },
  { id: "p3", cardId: "card-nu",   description: "Monitor 27\"",       totalAmount: 4500.00, date: "2026-10-10", monthsMsi: 3 }
];

const misSuscripciones = [
  {
    id: "sub1",
    cardId: "card-bbva",
    description: "Netflix + Spotify",
    amount: 450,
    chargeDay: 3,
    startDate: "2026-10-01",
    endDate: null // Sigue activa indefinidamente
  },
  {
    id: "sub2",
    cardId: "card-bbva",
    description: "Game Pass (Temporal)",
    amount: 250,
    chargeDay: 5,
    startDate: "2026-10-01",
    endDate: "2026-11-20" // Se cobra en octubre y noviembre, pero ya NO en diciembre
  }
];

const historialPagos = [
  {
    cardId: "card-bbva",
    paymentDueDate: "2026-10-28",
    amountPaid: 1000
  }
];

console.log("=== 1. RESUMEN DE TODAS MIS TARJETAS ===");
console.table(
  misTarjetas.map(card => getCardCreditSummary(card, misCompras, misSuscripciones, historialPagos, "2026-10-29"))
);

console.log("=== 2. ESTADOS DE CUENTA: BBVA AZUL (Observa cómo Game Pass desaparece en diciembre) ===");
console.table(getCardStatements(misCompras, misSuscripciones, misTarjetas[0], historialPagos, 6, "2026-10-29"));

console.log("=== 3. ESTADOS DE CUENTA: TARJETA NU ===");
console.table(getCardStatements(misCompras, misSuscripciones, misTarjetas[1], historialPagos, 6, "2026-10-29"));