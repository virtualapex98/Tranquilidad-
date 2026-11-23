// ==========================================
// 1. GENERADOR DE REGLAS RECURRENTES (QUINCENAL, FIN DE MES, SEMANAL, CATORCENAL)
// ==========================================

function projectCashflowEvents(rules, startYear, startMonth, monthsToProject = 6) {
  const events = [];
  const windowStartObj = new Date(startYear, startMonth, 1);
  const windowEndObj = new Date(startYear, startMonth + monthsToProject, 0);
  const windowStartStr = formatDate(windowStartObj);
  const windowEndStr = formatDate(windowEndObj);

  for (const rule of rules) {
    // CASO A: Evento programado de una sola vez
    if (rule.frequency === "once") {
      if (rule.date >= windowStartStr && rule.date <= windowEndStr) {
        events.push({
          id: rule.id,
          sourceRuleId: rule.id,
          title: rule.title,
          type: rule.type, // 'income' | 'direct_expense'
          amount: rule.amount,
          date: rule.date,
          category: rule.category || "Único"
        });
      }
      continue;
    }

    // CASO B: Semanal (cada 7 días) o Catorcenal (cada 14 días) a partir de startDate
    if (rule.frequency === "weekly" || rule.frequency === "biweekly") {
      const stepDays = rule.frequency === "weekly" ? 7 : 14;
      let currentObj = parseLocalDate(rule.startDate);

      while (formatDate(currentObj) <= windowEndStr) {
        const currentStr = formatDate(currentObj);
        if (currentStr >= windowStartStr && (!rule.endDate || currentStr <= rule.endDate)) {
          events.push({
            id: `${rule.id}-${currentStr}`,
            sourceRuleId: rule.id,
            title: rule.title,
            type: rule.type,
            amount: rule.amount,
            date: currentStr,
            category: rule.category || "Periódico"
          });
        }
        // Avanzamos exactamente 7 o 14 días en el calendario local
        currentObj = new Date(currentObj.getFullYear(), currentObj.getMonth(), currentObj.getDate() + stepDays);
      }
      continue;
    }

    // CASO C: Días fijos del mes o Quincenas (Poner 31 en daysOfMonth ajusta automático a fin de mes: 28, 30 o 31)
    for (let i = 0; i < monthsToProject; i++) {
      for (const day of (rule.daysOfMonth || [])) {
        const eventDateObj = createSafeDate(startYear, startMonth + i, day);
        const eventDateStr = formatDate(eventDateObj);

        if (rule.startDate && eventDateStr < rule.startDate) continue;
        if (rule.endDate && eventDateStr > rule.endDate) continue;

        events.push({
          id: `${rule.id}-${eventDateStr}`,
          sourceRuleId: rule.id,
          title: rule.title,
          type: rule.type, // 'income' | 'direct_expense'
          amount: rule.amount,
          date: eventDateStr,
          category: rule.category || "Recurrente"
        });
      }
    }
  }

  return events.sort((a, b) => a.date.localeCompare(b.date));
}

// ==========================================
// 2. CÁLCULO DE SALDO EN VIVO (CUENTA DE DÉBITO / EFECTIVO)
// ==========================================

function calculateLiveDebitBalance(initialAccountConfig, incomeConfig, cashflowRules, directTransactions, paymentsHistory, todayStr, actualPayrolls = [], loans = []) {
  const startObj = parseLocalDate(initialAccountConfig.startDate);
  const todayObj = parseLocalDate(todayStr);
  const monthsDiff = (todayObj.getFullYear() - startObj.getFullYear()) * 12 + (todayObj.getMonth() - startObj.getMonth()) + 2;

  // 1. Ingresos detallados reales calculados por incomeEngine (Nómina neta catorcenal) que ya ocurrieron hasta hoy
  const projectedIncomes = projectDetailedIncomes(incomeConfig, startObj.getFullYear(), startObj.getMonth(), Math.max(1, monthsDiff));
  // Si registraste la nómina real de una fecha, se usa ese monto en lugar de la proyección
  const pastIncomes = applyActualPayrolls(projectedIncomes, actualPayrolls, initialAccountConfig.startDate, todayStr)
    .filter(e => e.date >= initialAccountConfig.startDate && e.date <= todayStr);

  const scheduledIncomes = pastIncomes.reduce((sum, e) => sum + e.amount, 0);

  // 2. Gastos fijos programados (renta, internet, etc.) que ya ocurrieron desde la fecha base hasta hoy
  const expenseRulesOnly = cashflowRules.filter(r => r.type === "direct_expense");
  const scheduledExpenses = projectCashflowEvents(expenseRulesOnly, startObj.getFullYear(), startObj.getMonth(), Math.max(1, monthsDiff))
    .filter(e => e.date >= initialAccountConfig.startDate && e.date <= todayStr)
    .reduce((sum, e) => sum + e.amount, 0);

  // 3. Transacciones del día a día registradas 1 por 1 (tacos, gasolina, ingresos extra, o apartados de ahorro)
  const validDirectTx = directTransactions.filter(tx => tx.date >= initialAccountConfig.startDate && tx.date <= todayStr);

  const extraIncomes = validDirectTx
    .filter(tx => tx.type === "extra_income")
    .reduce((sum, tx) => sum + tx.amount, 0);

  const dailyDebitExpenses = validDirectTx
    .filter(tx => tx.type === "debit_expense")
    .reduce((sum, tx) => sum + tx.amount, 0);

  const savingsTransfers = validDirectTx
    .filter(tx => tx.type === "savings_transfer")
    .reduce((sum, tx) => sum + tx.amount, 0);

  // Ajustes de conciliación (monto con signo): sirven para cuadrar la app con tu saldo real sin mover la fecha base
  // Pagos de préstamos ya ocurridos (programados con fecha <= hoy, pagos archivados y abonos extra)
  const loanPayments = getLoanPaymentsTotal(loans, initialAccountConfig.startDate, todayStr);

  const adjustments = validDirectTx
    .filter(tx => tx.type === "adjustment")
    .reduce((sum, tx) => sum + tx.amount, 0);

  // 4. Pagos reales hechos a las tarjetas de crédito (dinero que salió del débito para pagar la TDC)
  const cardPaymentsTotal = paymentsHistory
    .filter(p => {
      const paidDate = p.paidOnDate || p.paymentDueDate;
      return paidDate >= initialAccountConfig.startDate && paidDate <= todayStr;
    })
    .reduce((sum, p) => sum + p.amountPaid, 0);

  const liveBalance = Number((
    initialAccountConfig.initialBalance +
    scheduledIncomes +
    extraIncomes +
    adjustments -
    loanPayments -
    scheduledExpenses -
    dailyDebitExpenses -
    savingsTransfers -
    cardPaymentsTotal
  ).toFixed(2));

  return {
    asOfDate: todayStr,
    initialBalance: initialAccountConfig.initialBalance,
    totalIncomesAdded: Number((scheduledIncomes + extraIncomes).toFixed(2)),
    totalFixedAndCardPaid: Number((scheduledExpenses + cardPaymentsTotal).toFixed(2)),
    totalDailyDebitSpent: Number(dailyDebitExpenses.toFixed(2)),
    totalSavedSoFar: Number(savingsTransfers.toFixed(2)),
    totalAdjustments: Number(adjustments.toFixed(2)),
    totalLoanPaid: loanPayments,
    currentAvailableDebit: liveBalance
  };
}

// ==========================================
// 3. UNIFICADOR DEL CALENDARIO MAESTRO
// ==========================================

function buildMasterTimeline(cards, purchases, subscriptions, paymentsHistory, cashflowRules, incomeConfig, directTransactions, startYear, startMonth, monthsToProject = 6, todayStr, actualPayrolls = [], loans = []) {
  // 1. Ingresos detallados calculados por el nuevo motor (Nómina neta catorcenal + impuestos + fondo de ahorro + bonos)
  const windowFrom = formatDate(new Date(startYear, startMonth, 1));
  const windowTo = formatDate(new Date(startYear, startMonth + monthsToProject, 0));
  const scheduledIncomes = applyActualPayrolls(
    projectDetailedIncomes(incomeConfig, startYear, startMonth, monthsToProject),
    actualPayrolls, windowFrom, windowTo
  );

  // 2. Reglas recurrentes de gastos fijos (renta, internet, etc. - excluyendo ingresos viejos)
  const expenseRulesOnly = cashflowRules.filter(r => r.type === "direct_expense");
  const scheduledExpenses = [
    ...projectCashflowEvents(expenseRulesOnly, startYear, startMonth, monthsToProject),
    // Mensualidades de préstamos (se tratan como gastos programados)
    ...getLoanEvents(loans, windowFrom, windowTo)
  ];

  // 3. Movimientos diarios 1 por 1 en débito/efectivo
  const manualEvents = directTransactions.map(tx => ({
    id: tx.id,
    title: tx.description,
    type: tx.type, // 'debit_expense' | 'extra_income' | 'savings_transfer'
    amount: tx.amount,
    date: tx.date,
    category: tx.category || "Movimiento Diario"
  }));

  // 4. Cortes y fechas límite de pago de todas las tarjetas
  const cardEvents = [];
  for (const card of cards) {
    const statements = getCardStatements(purchases, subscriptions, card, paymentsHistory, monthsToProject + 2, todayStr);
    
    for (const st of statements) {
      cardEvents.push({
        id: `cutoff-${card.id}-${st.cutoffDate}`,
        title: `✂️ Corte ${card.name}`,
        type: "card_cutoff",
        amount: st.newCharges,
        date: st.cutoffDate,
        cardId: card.id
      });

      cardEvents.push({
        id: `pay-${card.id}-${st.paymentDueDate}`,
        title: `💳 Pago ${card.name} (${st.status})`,
        type: "card_payment",
        amount: st.remainingBalance,
        totalStatementAmount: st.totalToPay,
        status: st.status,
        date: st.paymentDueDate,
        cardId: card.id
      });
    }
  }

  return [...scheduledIncomes, ...scheduledExpenses, ...manualEvents, ...cardEvents].sort((a, b) => a.date.localeCompare(b.date));
}
// ==========================================
// 4. MOTOR DE "TRANQUILIDAD" (PRESUPUESTO Y AHORRO DE NÓMINA A NÓMINA)
// ==========================================
// El periodo va del día de cobro anterior (inclusive) hasta el día antes de la próxima nómina.

function getPeaceOfMindMetrics(liveDebitSummary, savingsRatePercent, timeline, directTransactions, todayStr, incomeConfig) {
  const currentBalance = liveDebitSummary.currentAvailableDebit;
  const todayObj = parseLocalDate(todayStr);

  // 1. Periodo de nómina vigente
  const period = getPayPeriod(incomeConfig, todayStr);
  const periodStartStr = period.periodStart;
  const periodEndStr = period.nextPayDate;
  const diffDays = period.daysToNextPay;

  // 2. Próxima nómina (si ya está dentro de la línea de tiempo, mostramos su monto)
  const nextPayroll = timeline.find(e => e.isPayroll && e.date === periodEndStr) || null;

  // 3. Ingresos recibidos en este periodo (nómina que abrió el periodo + ingresos extra)
  const periodIncomesTotal = timeline
    .filter(e => (e.type === "income" || e.type === "extra_income") && e.date >= periodStartStr && e.date <= todayStr)
    .reduce((sum, e) => sum + e.amount, 0);

  // 4. Compromisos (gastos fijos y pagos de tarjeta) pendientes ANTES de la próxima nómina
  const upcomingObligations = timeline.filter(e =>
    ((e.type === "direct_expense" && e.date > todayStr) || (e.type === "card_payment" && e.amount > 0 && e.date >= todayStr)) &&
    e.date < periodEndStr
  );

  const totalCommitmentsBeforePayday = Number(
    upcomingObligations.reduce((sum, item) => sum + item.amount, 0).toFixed(2)
  );

  // 5. Ahorro: porcentaje sobre los ingresos del periodo
  const basePeriodIncome = periodIncomesTotal > 0 ? periodIncomesTotal : currentBalance;
  const targetSavingsForPeriod = Number((basePeriodIncome * (savingsRatePercent / 100)).toFixed(2));

  const alreadySavedThisPeriod = directTransactions
    .filter(tx => tx.type === "savings_transfer" && tx.date >= periodStartStr && tx.date <= todayStr)
    .reduce((sum, tx) => sum + tx.amount, 0);

  const remainingSavingsToSetAside = Math.max(0, Number((targetSavingsForPeriod - alreadySavedThisPeriod).toFixed(2)));

  // 6. Gasto libre total y diario seguro
  const freeToSpendTotal = Number((currentBalance - totalCommitmentsBeforePayday - remainingSavingsToSetAside).toFixed(2));
  const safeDailyBudget = Number((freeToSpendTotal / diffDays).toFixed(2));

  return {
    consultaAlDia: todayStr,
    inicioPeriodo: periodStartStr,
    proximaNominaFecha: periodEndStr,
    proximaNominaMonto: nextPayroll ? nextPayroll.amount : null,
    ingresosTotalesPeriodo: basePeriodIncome,
    saldoDisponibleHoy: currentBalance,
    diasParaNomina: diffDays,
    compromisosPorPagar: totalCommitmentsBeforePayday,
    metaAhorroPeriodo: targetSavingsForPeriod,
    yaAhorradoEnPeriodo: alreadySavedThisPeriod,
    faltaApartarAhorro: remainingSavingsToSetAside,
    gastoLibreTotal: freeToSpendTotal,
    gastoDiarioSeguro: safeDailyBudget,
    estadoSalud: freeToSpendTotal >= 0
      ? "✅ TRANQUILIDAD TOTAL: Cubres pagos, ahorro y tienes flujo libre"
      : "⚠️ ALERTA: Tus compromisos superan tu liquidez libre",
    detalleCompromisos: upcomingObligations
  };
}

// ==========================================
// 5. SIMULADOR DE SALDO FUTURO DÍA POR DÍA
// ==========================================

function projectRunningBalance(currentAvailableDebit, timeline, todayStr, endDateStr) {
  let runningBalance = currentAvailableDebit;
  const ledger = [];

  // Efecto en débito de cada tipo de evento FUTURO (el pasado ya está en el saldo de hoy)
  const effectOf = (e) => {
    if (e.date > endDateStr) return 0;
    switch (e.type) {
      case "income":
      case "extra_income":
        return e.date > todayStr ? e.amount : 0;
      case "direct_expense":
      case "debit_expense":
      case "savings_transfer":
        return e.date > todayStr ? -e.amount : 0;
      case "card_payment":
        return (e.amount > 0 && e.date >= todayStr) ? -e.amount : 0;
      default:
        return 0;
    }
  };

  for (const ev of timeline) {
    const change = effectOf(ev);
    if (!change) continue;
    runningBalance = Number((runningBalance + change).toFixed(2));

    ledger.push({
      fecha: ev.date,
      concepto: ev.title,
      tipo: change > 0 ? "➕ INGRESO" : "➖ SALIDA",
      monto: ev.amount,
      saldoProyectado: runningBalance,
      alerta: runningBalance < 0 ? "🚨 SALDO INSUFICIENTE" : "OK"
    });
  }

  return ledger;
}

// ==========================================
// 5. PROYECCIÓN A LARGO PLAZO: ¿CUÁNDO QUEDO LIBRE DE DEUDAS?
// ==========================================
// Corre la línea de tiempo mes a mes hasta que ya no queden pagos de tarjetas ni préstamos.
// Solo cuenta lo ya registrado (nómina, préstamos, tarjetas y movimientos futuros); NO incluye gasto diario
// ni compras futuras. Devuelve el libro mayor y un resumen:
//   minBalance / minBalanceDate : el punto más bajo (cuánto dinero extra necesitarías)
//   recoveryDate                : primera fecha desde la cual el saldo ya no vuelve a ser negativo (null si nunca)
//   lastDebtPaymentDate         : fecha del último pago de tarjeta o préstamo (libre de deudas)
//   balanceAtDebtFree           : saldo proyectado ese día
function projectDebtFreeOutlook(currentAvailableDebit, cards, purchases, subscriptions, paymentsHistory, cashflowRules, incomeConfig, directTransactions, todayStr, actualPayrolls = [], loans = [], maxMonths = 84) {
  const [ty, tm] = todayStr.split("-").map(Number);
  const timeline = buildMasterTimeline(cards, purchases, subscriptions, paymentsHistory, cashflowRules, incomeConfig, directTransactions, ty, tm - 1, maxMonths, todayStr, actualPayrolls, loans);
  const endStr = formatDate(new Date(ty, tm - 1 + maxMonths, 0));
  const ledger = projectRunningBalance(currentAvailableDebit, timeline, todayStr, endStr);

  let lastDebt = null;
  for (const e of timeline) {
    const isDebt = (e.type === "card_payment" && e.amount > 0 && e.date >= todayStr) || (e.loanId && e.date > todayStr);
    if (isDebt && e.date <= endStr && (!lastDebt || e.date > lastDebt)) lastDebt = e.date;
  }

  let min = null;
  for (const r of ledger) if (!min || r.saldoProyectado < min.saldoProyectado) min = r;

  // Recuperación: la primera fila a partir de la cual todos los saldos siguientes son >= 0
  let recoveryDate = null;
  const everNegative = ledger.some(r => r.saldoProyectado < 0);
  if (everNegative) {
    let idx = -1;
    for (let k = ledger.length - 1; k >= 0; k--) { if (ledger[k].saldoProyectado < 0) { idx = k; break; } }
    recoveryDate = idx + 1 < ledger.length ? ledger[idx + 1].fecha : null;
  }

  const atDebtFree = lastDebt ? ledger.filter(r => r.fecha <= lastDebt).pop() : null;
  return {
    ledger,
    startsNegative: currentAvailableDebit < 0,
    everNegative,
    minBalance: min ? min.saldoProyectado : currentAvailableDebit,
    minBalanceDate: min ? min.fecha : null,
    recoveryDate,
    lastDebtPaymentDate: lastDebt,
    balanceAtDebtFree: atDebtFree ? atDebtFree.saldoProyectado : currentAvailableDebit,
    horizonEnd: endStr,
    debtFreeWithinHorizon: lastDebt !== null && lastDebt < endStr
  };
}
