document.addEventListener("DOMContentLoaded", () => {

    // ── Sidebar collapse toggle ──
    const sidebar = document.getElementById('sidebar');
    const mainWrapper = document.querySelector('.main-wrapper');
    const collapseBtn = document.getElementById('sidebarCollapseBtn');

    function getSidebarState() { return localStorage.getItem('sidebar-collapsed') === 'true'; }
    function applySidebarState(collapsed) {
        if (!sidebar) return;
        if (collapsed) {
            sidebar.classList.add('collapsed');
            if (mainWrapper) mainWrapper.style.marginLeft = 'var(--sidebar-collapsed-width, 56px)';
        } else {
            sidebar.classList.remove('collapsed');
            if (mainWrapper) mainWrapper.style.marginLeft = '';
        }
    }
    applySidebarState(getSidebarState());
    if (collapseBtn) {
        collapseBtn.addEventListener('click', () => {
            const next = !getSidebarState();
            localStorage.setItem('sidebar-collapsed', next);
            applySidebarState(next);
        });
    }

    // ── Tax Calculator (add form) ──
    const rates = { GST: 0.05, HST13: 0.13, HST15: 0.15, None: 0 };

    function getFeesTotal(container) {
        let t = 0;
        if (!container) return t;
        container.querySelectorAll('.fee-amount-input').forEach(i => { t += parseFloat(i.value) || 0; });
        return t;
    }

    function recalc() {
        const amountIn  = document.getElementById("amount");
        const taxSelect = document.getElementById("tax_type");
        const netEl     = document.getElementById("calc-net");
        const taxEl     = document.getElementById("calc-tax");
        const totalEl   = document.getElementById("calc-total");
        const feesEl    = document.getElementById("calc-fees");
        const feesRow   = document.getElementById("calc-fees-row");
        const feesLabel = document.getElementById("calc-fees-label");
        const labelEl   = document.getElementById("total-label");
        const payHidden = document.getElementById("payment_type");

        if (!amountIn || !taxSelect) return;
        const net  = parseFloat(amountIn.value) || 0;
        const rate = rates[taxSelect.value] ?? 0;
        const tax  = net * rate;
        const fees = getFeesTotal(document.getElementById('fees-container'));
        const total = net + tax + fees;

        if (netEl)   netEl.textContent   = "$" + net.toFixed(2);
        if (taxEl)   taxEl.textContent   = "$" + tax.toFixed(2);
        if (totalEl) totalEl.textContent = "$" + total.toFixed(2);

        if (feesEl && feesRow) {
            if (fees > 0) {
                feesRow.style.display = '';
                if (feesLabel) {
                    const feeNames = [];
                    document.querySelectorAll('.fee-desc-input').forEach(i => { if (i.value.trim()) feeNames.push(i.value.trim()); });
                    feesLabel.textContent = feeNames.length > 0 ? feeNames.join(', ') + ':' : 'Extra Fees:';
                }
                feesEl.textContent = "$" + fees.toFixed(2);
            } else {
                feesRow.style.display = 'none';
            }
        }

        const payType = payHidden ? payHidden.value : 'Reimbursement';
        if (labelEl) labelEl.textContent = payType === 'Company Card' ? 'Total Company Card Cost:' : 'Total Reimbursable:';
    }

    const amountIn  = document.getElementById("amount");
    const taxSelect = document.getElementById("tax_type");
    if (amountIn)  amountIn.addEventListener("input",  recalc);
    if (taxSelect) taxSelect.addEventListener("change", recalc);
    recalc();

    // ── Payment Method Toggle Buttons ──
    const reGroup = document.getElementById('reimbursement_type_group');
    const reSelect = document.getElementById('expense_type');
    const wbsHidden = document.getElementById('wbs_code_hidden');

    if (reSelect && wbsHidden) {
        reSelect.addEventListener('change', () => {
            const opt = reSelect.options[reSelect.selectedIndex];
            wbsHidden.value = opt ? (opt.getAttribute('data-wbs') || '') : '';
        });
    }

    window.setPayMethod = function(val) {
        const hidden = document.getElementById('payment_type');
        if (hidden) hidden.value = val;
        document.querySelectorAll('#payToggle .pay-btn').forEach(b => {
            b.classList.toggle('active', b.getAttribute('data-value') === val);
        });
        if (reGroup && reSelect) {
            if (val === 'Reimbursement') {
                reGroup.style.display = '';
                reSelect.setAttribute('required', 'required');
            } else {
                reGroup.style.display = 'none';
                reSelect.removeAttribute('required');
                reSelect.value = '';
                if (wbsHidden) wbsHidden.value = '';
            }
        }
        recalc();
    };

    // Initial load setup for pay method
    const initialPayType = document.getElementById('payment_type')?.value || 'Reimbursement';
    setPayMethod(initialPayType);

    // Set from edit modal hidden field if needed
    const editPayHidden = document.getElementById('edit_payment_type_hidden');

    // ── Manual Job Number toggle ──
    window.toggleManualJob = function(val) {
        const manualInput = document.getElementById('job_number_manual');
        if (!manualInput) return;
        if (val === '__manual__') {
            manualInput.style.display = 'block';
            manualInput.focus();
        } else {
            manualInput.style.display = 'none';
            manualInput.value = '';
        }
    };
    window.toggleManualJobEdit = function(val) {
        const manualInput = document.getElementById('edit_job_number_manual');
        if (!manualInput) return;
        if (val === '__manual__') {
            manualInput.style.display = 'block';
            manualInput.focus();
        } else {
            manualInput.style.display = 'none';
            manualInput.value = '';
        }
    };

    // ── Fee Rows ──
    let feeCount = 0;
    window.addFeeRow = function(container) {
        const c = typeof container === 'string' ? document.getElementById(container) : document.getElementById('fees-container');
        if (!c) return;
        feeCount++;
        const row = document.createElement('div');
        row.className = 'fee-row';
        row.style.cssText = 'display:flex; gap:0.5rem; align-items:center;';
        row.innerHTML = `
            <input type="text" placeholder="Fee description (e.g. Airport fee)" class="fee-desc-input" style="flex:2; font-size:0.82rem; padding:0.45rem 0.7rem; border:1.5px solid var(--border); border-radius:var(--radius-sm); background:var(--surface); color:var(--text); font-family:var(--font);">
            <input type="number" placeholder="0.00" class="fee-amount-input" step="0.01" min="0" style="flex:1; font-size:0.82rem; padding:0.45rem 0.7rem; border:1.5px solid var(--border); border-radius:var(--radius-sm); background:var(--surface); color:var(--text); font-family:var(--font);">
            <button type="button" onclick="this.parentElement.remove(); recalcFromAny();" style="background:var(--danger-light); color:var(--danger); border:none; border-radius:var(--radius-sm); width:28px; height:28px; cursor:pointer; display:flex; align-items:center; justify-content:center; flex-shrink:0;">
                <i class="fa-solid fa-xmark" style="font-size:0.8rem;"></i>
            </button>`;
        row.querySelectorAll('input').forEach(i => i.addEventListener('input', recalcFromAny));
        c.appendChild(row);
    };

    window.recalcFromAny = recalc;

    // ── Serialize fees to hidden input before submit ──
    window.serializeFeesBeforeSubmit = function(hiddenId) {
        const hidden = document.getElementById(hiddenId);
        if (!hidden) return;
        const fees = [];
        document.querySelectorAll('#fees-container .fee-row').forEach(row => {
            const desc = row.querySelector('.fee-desc-input')?.value.trim() || '';
            const amt  = parseFloat(row.querySelector('.fee-amount-input')?.value) || 0;
            if (amt > 0) fees.push({ description: desc, amount: amt });
        });
        hidden.value = JSON.stringify(fees);
    };

    // Also serialize on form submit
    const addForm = document.getElementById('addExpenseForm');
    if (addForm) {
        addForm.addEventListener('submit', () => {
            window.serializeFeesBeforeSubmit('fees_json_hidden');
        });
    }

    // ── AI Receipt Scanner (Main Expense Form) ──
    const btnScanReceipt = document.getElementById('btn-scan-receipt');
    const inputReceiptPhoto = document.getElementById('receipt_photo');
    const scanStatusMsg = document.getElementById('scan-status-message');

    if (btnScanReceipt && inputReceiptPhoto && scanStatusMsg) {
        btnScanReceipt.addEventListener('click', async () => {
            const file = inputReceiptPhoto.files[0];
            if (!file) {
                scanStatusMsg.style.display = 'block';
                scanStatusMsg.style.color = 'var(--danger)';
                scanStatusMsg.innerHTML = '<i class="fa-solid fa-circle-exclamation"></i> Please select or take a photo of a receipt first.';
                return;
            }

            // Start scanning
            btnScanReceipt.disabled = true;
            const originalBtnContent = btnScanReceipt.innerHTML;
            btnScanReceipt.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Scanning...';
            
            scanStatusMsg.style.display = 'block';
            scanStatusMsg.style.color = 'var(--primary)';
            scanStatusMsg.innerHTML = 'Gemini AI is reading your receipt...';

            const formData = new FormData();
            formData.append('receipt_photo', file);

            try {
                const response = await fetch('/expenses/scan-receipt', {
                    method: 'POST',
                    body: formData
                });

                const data = await response.json();
                if (!response.ok || data.error) {
                    throw new Error(data.error || 'Failed to scan receipt');
                }

                // Fill form fields
                if (data.store_name) {
                    const storeInput = document.getElementById('store_name');
                    if (storeInput) {
                        storeInput.value = data.store_name;
                        flashField(storeInput);
                    }
                }
                if (data.transaction_id) {
                    const txnInput = document.getElementById('transaction_id');
                    if (txnInput) {
                        txnInput.value = data.transaction_id;
                        flashField(txnInput);
                    }
                }
                if (data.date) {
                    const dateInput = document.getElementById('date');
                    if (dateInput) {
                        dateInput.value = data.date;
                        flashField(dateInput);
                    }
                }
                if (data.net_amount || data.total_amount) {
                    const amountInput = document.getElementById('amount');
                    if (amountInput) {
                        let netVal = data.net_amount;
                        if (!netVal && data.total_amount) {
                            if (data.tax_amount) {
                                netVal = data.total_amount - data.tax_amount;
                            } else {
                                netVal = data.total_amount;
                            }
                        }
                        amountInput.value = parseFloat(netVal || 0).toFixed(2);
                        flashField(amountInput);
                    }
                }
                if (data.tax_type) {
                    const taxInput = document.getElementById('tax_type');
                    if (taxInput) {
                        taxInput.value = data.tax_type;
                        flashField(taxInput);
                    }
                }
                if (data.description) {
                    const descInput = document.getElementById('description');
                    if (descInput) {
                        descInput.value = data.description;
                        flashField(descInput);
                    }
                }

                // Trigger recalculation
                if (typeof recalc === 'function') recalc();
                else if (typeof window.recalcFromAny === 'function') window.recalcFromAny();

                scanStatusMsg.style.color = 'var(--success)';
                scanStatusMsg.innerHTML = '<i class="fa-solid fa-circle-check"></i> Scan complete! Filled fields are highlighted.';
            } catch (err) {
                console.error('Scan error:', err);
                scanStatusMsg.style.color = 'var(--danger)';
                scanStatusMsg.innerHTML = `<i class="fa-solid fa-circle-exclamation"></i> Error: ${err.message}. Please enter manually.`;
            } finally {
                btnScanReceipt.disabled = false;
                btnScanReceipt.innerHTML = originalBtnContent;
            }
        });
    }

    // ── AI Receipt Scanner (Gas Expense Form) ──
    const btnScanReceiptGas = document.getElementById('btn-scan-receipt-gas');
    const scanStatusMsgGas = document.getElementById('scan-status-message-gas');

    if (btnScanReceiptGas && scanStatusMsgGas) {
        btnScanReceiptGas.addEventListener('click', async () => {
            const form = document.getElementById('addGasExpenseForm');
            if (!form) return;
            const fileInput = form.querySelector('input[type="file"]');
            const file = fileInput ? fileInput.files[0] : null;

            if (!file) {
                scanStatusMsgGas.style.display = 'block';
                scanStatusMsgGas.style.color = 'var(--danger)';
                scanStatusMsgGas.innerHTML = '<i class="fa-solid fa-circle-exclamation"></i> Please select or take a photo of a receipt first.';
                return;
            }

            // Start scanning
            btnScanReceiptGas.disabled = true;
            const originalBtnContent = btnScanReceiptGas.innerHTML;
            btnScanReceiptGas.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Scanning...';
            
            scanStatusMsgGas.style.display = 'block';
            scanStatusMsgGas.style.color = 'var(--primary)';
            scanStatusMsgGas.innerHTML = 'Gemini AI is reading your receipt...';

            const formData = new FormData();
            formData.append('receipt_photo', file);

            try {
                const response = await fetch('/expenses/scan-receipt', {
                    method: 'POST',
                    body: formData
                });

                const data = await response.json();
                if (!response.ok || data.error) {
                    throw new Error(data.error || 'Failed to scan receipt');
                }

                // Fill gas form fields
                if (data.store_name) {
                    const storeInput = form.querySelector('#store_name');
                    if (storeInput) {
                        storeInput.value = data.store_name;
                        flashField(storeInput);
                    }
                }
                if (data.transaction_id) {
                    const txnInput = form.querySelector('#transaction_id');
                    if (txnInput) {
                        txnInput.value = data.transaction_id;
                        flashField(txnInput);
                    }
                }
                if (data.date) {
                    const dateInput = form.querySelector('#date');
                    if (dateInput) {
                        dateInput.value = data.date;
                        flashField(dateInput);
                    }
                }
                if (data.net_amount || data.total_amount) {
                    const netInput = form.querySelector('#net_amount');
                    if (netInput) {
                        let netVal = data.net_amount;
                        if (!netVal && data.total_amount) {
                            if (data.tax_amount) {
                                netVal = data.total_amount - data.tax_amount - (data.fees_amount || 0);
                            } else {
                                netVal = data.total_amount;
                            }
                        }
                        netInput.value = parseFloat(netVal || 0).toFixed(2);
                        flashField(netInput);
                    }
                }
                if (data.tax_amount !== undefined) {
                    const taxInput = form.querySelector('#tax_amount');
                    if (taxInput) {
                        taxInput.value = parseFloat(data.tax_amount || 0).toFixed(2);
                        flashField(taxInput);
                    }
                }
                if (data.fees_amount !== undefined) {
                    const feesInput = form.querySelector('#fees_amount');
                    if (feesInput) {
                        feesInput.value = parseFloat(data.fees_amount || 0).toFixed(2);
                        flashField(feesInput);
                    }
                }
                if (data.liters_purchased) {
                    const litersInput = form.querySelector('#liters_in_tank');
                    if (litersInput) {
                        litersInput.value = parseFloat(data.liters_purchased).toFixed(2);
                        flashField(litersInput);
                    }
                }
                if (data.description) {
                    const descInput = form.querySelector('#description');
                    if (descInput) {
                        descInput.value = data.description;
                        flashField(descInput);
                    }
                }

                // Trigger recalculation
                if (typeof calculateTotal === 'function') {
                    calculateTotal();
                } else if (typeof window.calculateTotal === 'function') {
                    window.calculateTotal();
                }

                scanStatusMsgGas.style.color = 'var(--success)';
                scanStatusMsgGas.innerHTML = '<i class="fa-solid fa-circle-check"></i> Scan complete! Filled fields are highlighted.';
            } catch (err) {
                console.error('Scan error:', err);
                scanStatusMsgGas.style.color = 'var(--danger)';
                scanStatusMsgGas.innerHTML = `<i class="fa-solid fa-circle-exclamation"></i> Error: ${err.message}. Please enter manually.`;
            } finally {
                btnScanReceiptGas.disabled = false;
                btnScanReceiptGas.innerHTML = originalBtnContent;
            }
        });
    }

    function flashField(element) {
        element.style.transition = 'none';
        element.style.borderColor = 'var(--primary)';
        element.style.boxShadow = '0 0 0 4px rgba(0, 115, 234, 0.25)';
        setTimeout(() => {
            element.style.transition = 'border-color var(--transition), box-shadow var(--transition)';
            element.style.borderColor = '';
            element.style.boxShadow = '';
        }, 1500);
    }

    // ── Receipt Photo Modal ──
    const modal    = document.getElementById("receiptModal");
    const modalImg = document.getElementById("modalImg");
    const closeBtn = document.getElementById("modalClose");

    window.viewReceipt = function(src) {
        if (!modal || !modalImg) return;
        modalImg.src = src;
        modal.classList.add("open");
        document.body.style.overflow = "hidden";
    };

    function closeModal() {
        if (!modal) return;
        modal.classList.remove("open");
        document.body.style.overflow = "";
    }
    if (closeBtn) closeBtn.addEventListener("click", closeModal);
    if (modal) modal.addEventListener("click", e => { if (e.target === modal) closeModal(); });

    // ── Edit Expense Modal ──
    const editModal = document.getElementById("editExpenseModal");
    const editModalClose = document.getElementById("editModalClose");

    const editAmountIn  = document.getElementById("edit_amount");
    const editTaxSelect = document.getElementById("edit_tax_type");
    const editNetEl     = document.getElementById("edit-calc-net");
    const editTaxEl     = document.getElementById("edit-calc-tax");
    const editTotalEl   = document.getElementById("edit-calc-total");
    const editLabelEl   = document.getElementById("edit-total-label");

    function recalcEdit() {
        if (!editAmountIn || !editTaxSelect) return;
        const net   = parseFloat(editAmountIn.value) || 0;
        const rate  = rates[editTaxSelect.value] ?? 0;
        const tax   = net * rate;
        const total = net + tax;
        if (editNetEl)   editNetEl.textContent   = "$" + net.toFixed(2);
        if (editTaxEl)   editTaxEl.textContent   = "$" + tax.toFixed(2);
        if (editTotalEl) editTotalEl.textContent = "$" + total.toFixed(2);
        const editPaySel = document.getElementById("edit_payment_type");
        if (editPaySel && editLabelEl) {
            editLabelEl.textContent = editPaySel.value === 'Company Card' ? 'Total Company Card Cost:' : 'Total Reimbursable:';
        }
    }

    if (editAmountIn)  editAmountIn.addEventListener("input",  recalcEdit);
    if (editTaxSelect) editTaxSelect.addEventListener("change", recalcEdit);

    window.closeEditModal = function() {
        if (!editModal) return;
        editModal.classList.remove("open");
        document.body.style.overflow = "";
    };

    if (editModalClose) editModalClose.addEventListener("click", window.closeEditModal);
    if (editModal) editModal.addEventListener("click", e => { if (e.target === editModal) window.closeEditModal(); });

    // Edit buttons
    document.querySelectorAll(".edit-expense-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            const id = btn.getAttribute("data-id");
            const store = btn.getAttribute("data-store");
            const txn = btn.getAttribute("data-txn");
            const date = btn.getAttribute("data-date");
            const job = btn.getAttribute("data-job");
            const supervisor = btn.getAttribute("data-supervisor");
            const amount = btn.getAttribute("data-amount");
            const tax = btn.getAttribute("data-tax");
            const payment = btn.getAttribute("data-payment");
            const desc = btn.getAttribute("data-desc");

            const form = document.getElementById("editExpenseForm");
            if (form) form.action = `/expenses/edit/${id}`;

            ['edit_store_name', 'edit_transaction_id', 'edit_date', 'edit_amount', 'edit_description'].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.value = btn.getAttribute('data-' + id.replace('edit_','').replace('_name','_store').replace('edit_', '')) || '';
            });

            const storeIn = document.getElementById("edit_store_name"); if (storeIn) storeIn.value = store;
            const txnIn   = document.getElementById("edit_transaction_id"); if (txnIn) txnIn.value = txn;
            const dateIn  = document.getElementById("edit_date"); if (dateIn) dateIn.value = date;
            const amtIn   = document.getElementById("edit_amount"); if (amtIn) amtIn.value = amount;
            const descIn  = document.getElementById("edit_description"); if (descIn) descIn.value = desc;

            const jobSel = document.getElementById("edit_job_number"); if (jobSel) jobSel.value = job;
            const supSel = document.getElementById("edit_supervisor"); if (supSel) supSel.value = supervisor;
            const taxSel = document.getElementById("edit_tax_type"); if (taxSel) taxSel.value = tax;
            const paySel = document.getElementById("edit_payment_type"); if (paySel) paySel.value = payment;

            const expType = btn.getAttribute("data-expense-type");
            const wbs = btn.getAttribute("data-wbs");
            const editReSel = document.getElementById("edit_expense_type");
            const editWbsHid = document.getElementById("edit_wbs_code_hidden");
            if (editReSel) editReSel.value = expType || '';
            if (editWbsHid) editWbsHid.value = wbs || '';

            setEditPayMethod(payment);
            recalcEdit();

            if (editModal) {
                editModal.classList.add("open");
                document.body.style.overflow = "hidden";
            }
        });
    });

    const editReGroup = document.getElementById('edit_reimbursement_type_group');
    const editReSelect = document.getElementById('edit_expense_type');
    const editWbsHidden = document.getElementById('edit_wbs_code_hidden');

    if (editReSelect && editWbsHidden) {
        editReSelect.addEventListener('change', () => {
            const opt = editReSelect.options[editReSelect.selectedIndex];
            editWbsHidden.value = opt ? (opt.getAttribute('data-wbs') || '') : '';
        });
    }

    // Edit payment pills in modal
    window.setEditPayMethod = function(val) {
        const sel = document.getElementById('edit_payment_type');
        if (sel) { sel.value = val; }
        document.querySelectorAll('.edit-pay-btn').forEach(b => b.classList.toggle('active', b.getAttribute('data-value') === val));
        
        if (editReGroup && editReSelect) {
            if (val === 'Reimbursement') {
                editReGroup.style.display = '';
                editReSelect.setAttribute('required', 'required');
            } else {
                editReGroup.style.display = 'none';
                editReSelect.removeAttribute('required');
                editReSelect.value = '';
                if (editWbsHidden) editWbsHidden.value = '';
            }
        }
        recalcEdit();
    };

    // ── Void Expense Modal ──
    const voidModal = document.getElementById('voidModal');
    window.openVoidModal = function(id, store) {
        const expIdIn = document.getElementById('void_expense_id');
        const labelEl = document.getElementById('void_expense_label');
        if (expIdIn) expIdIn.value = id;
        if (labelEl) labelEl.textContent = store;
        if (voidModal) { voidModal.classList.add('open'); document.body.style.overflow = 'hidden'; }
    };
    window.closeVoidModal = function() {
        if (voidModal) { voidModal.classList.remove('open'); document.body.style.overflow = ''; }
    };
    if (voidModal) voidModal.addEventListener('click', e => { if (e.target === voidModal) window.closeVoidModal(); });

    // ── Expense Logs Modal ──
    const logsModal = document.getElementById('logsModal');
    window.viewExpenseLogs = async function(id) {
        if (!logsModal) return;
        const body = document.getElementById('logsModalBody');
        if (body) body.innerHTML = '<div style="text-align:center; padding:2rem; color:var(--text-muted);"><i class="fa-solid fa-spinner fa-spin"></i> Loading…</div>';
        logsModal.classList.add('open');
        document.body.style.overflow = 'hidden';
        try {
            const resp = await fetch(`/expenses/${id}/logs`);
            const data = await resp.json();
            if (!data.logs || data.logs.length === 0) {
                if (body) body.innerHTML = '<div class="empty-state"><i class="fa-solid fa-clock-rotate-left"></i><p>No activity logs found.</p></div>';
                return;
            }

            // Find submission and approval events to calculate processing days
            const submittedEvent = [...data.logs].reverse().find(l => l.action === 'submitted');
            const approvedEvent = data.logs.find(l => l.action === 'approved');
            let approvalStatsHtml = '';
            if (submittedEvent && approvedEvent) {
                const subDate = new Date(submittedEvent.created_at);
                const appDate = new Date(approvedEvent.created_at);
                const diffTime = Math.abs(appDate - subDate);
                const diffDays = Math.max(0, Math.round(diffTime / (1000 * 60 * 60 * 24)));
                approvalStatsHtml = `
                    <div style="margin-bottom:0.75rem; padding:0.5rem 0.75rem; background:rgba(46,204,113,0.1); color:#2ecc71; border-radius:6px; font-size:0.78rem; font-weight:600; display:flex; align-items:center; justify-content:space-between; border:1px solid rgba(46,204,113,0.25);">
                        <span><i class="fa-solid fa-calendar-check"></i> Processing Duration:</span>
                        <span>${diffDays} day${diffDays === 1 ? '' : 's'}</span>
                    </div>
                `;
            } else if (submittedEvent) {
                const subDate = new Date(submittedEvent.created_at);
                const diffTime = Math.abs(new Date() - subDate);
                const diffDays = Math.max(0, Math.round(diffTime / (1000 * 60 * 60 * 24)));
                approvalStatsHtml = `
                    <div style="margin-bottom:0.75rem; padding:0.5rem 0.75rem; background:rgba(243,156,18,0.1); color:#f39c12; border-radius:6px; font-size:0.78rem; font-weight:600; display:flex; align-items:center; justify-content:space-between; border:1px solid rgba(243,156,18,0.25);">
                        <span><i class="fa-solid fa-hourglass-half"></i> Pending in queue for:</span>
                        <span>${diffDays} day${diffDays === 1 ? '' : 's'}</span>
                    </div>
                `;
            }

            const rows = data.logs.map(l => `
                <div style="display:flex; gap:0.75rem; align-items:flex-start; padding:0.65rem 0; border-bottom:1px solid var(--border-light);">
                    <div style="width:34px; height:34px; border-radius:50%; background:var(--primary-light); display:flex; align-items:center; justify-content:center; flex-shrink:0; color:var(--primary); font-size:0.8rem;">
                        <i class="fa-solid ${actionIcon(l.action)}"></i>
                    </div>
                    <div style="flex:1; min-width:0;">
                        <div style="font-weight:600; font-size:0.82rem; color:var(--text);">${actionLabel(l.action)}</div>
                        <div style="font-size:0.75rem; color:var(--text-muted);">${l.actor_name || 'System'} · ${(l.created_at||'').toString().split('T')[0]}</div>
                        ${l.reason ? `<div style="font-size:0.75rem; color:var(--danger); margin-top:0.2rem; background:var(--danger-light); padding:0.2rem 0.5rem; border-radius:4px;">${l.reason}</div>` : ''}
                    </div>
                </div>`).join('');
            if (body) body.innerHTML = approvalStatsHtml + rows;
        } catch (e) {
            if (body) body.innerHTML = '<div class="alert alert-error"><i class="fa-solid fa-circle-exclamation"></i><span>Failed to load logs.</span></div>';
        }
    };
    window.closeLogsModal = function() {
        if (logsModal) { logsModal.classList.remove('open'); document.body.style.overflow = ''; }
    };
    if (logsModal) logsModal.addEventListener('click', e => { if (e.target === logsModal) window.closeLogsModal(); });

    function actionIcon(a) {
        const map = { submitted:'cloud-arrow-up', edited:'pen-to-square', approved:'circle-check', rejected:'circle-xmark', voided:'ban', resubmitted_after_rejection:'rotate-right', deleted_by_admin:'trash' };
        return map[a] || 'circle-dot';
    }
    function actionLabel(a) {
        const map = { submitted:'Submitted', edited:'Edited', approved:'Approved', rejected:'Rejected', voided:'Voided by user', resubmitted_after_rejection:'Resubmitted after rejection', deleted_by_admin:'Deleted by admin' };
        return map[a] || a;
    }

    // ── Profile Modal ──
    const profileModal = document.getElementById("editProfileModal");
    const editProfileBtn = document.getElementById("editProfileBtn");

    window.closeProfileModal = function() {
        if (profileModal) { profileModal.classList.remove("open"); document.body.style.overflow = ""; }
    };

    if (editProfileBtn) {
        editProfileBtn.addEventListener("click", () => {
            if (profileModal) { profileModal.classList.add("open"); document.body.style.overflow = "hidden"; }
        });
    }

    // ── Global Escape key ──
    document.addEventListener("keydown", e => {
        if (e.key === "Escape") {
            closeModal();
            window.closeEditModal?.();
            window.closeProfileModal?.();
            window.closeVoidModal?.();
            window.closeLogsModal?.();
        }
    });
});

// Collapsible Top Menu Slide down
window.toggleTopMenu = function() {
    const content = document.getElementById('topMenuContent');
    const icon = document.querySelector('.collapsible-top-menu .toggle-icon');
    if (!content) return;
    if (content.classList.contains('open')) {
        content.style.maxHeight = content.scrollHeight + 'px';
        content.offsetHeight; // force reflow
        content.style.maxHeight = '0px';
        content.classList.remove('open');
        if (icon) icon.style.transform = 'rotate(0deg)';
    } else {
        content.classList.add('open');
        content.style.maxHeight = content.scrollHeight + 'px';
        setTimeout(() => {
            if (content.classList.contains('open')) {
                content.style.maxHeight = 'none';
            }
        }, 300);
        if (icon) icon.style.transform = 'rotate(180deg)';
    }
};

// Client-side table sorting with cycles (0: original, 1: asc, 2: desc)
const sortStates = {};
let originalRows = {};

window.sortTable = function(tableId, colIndex, headerElement, type = 'text') {
    const table = document.getElementById(tableId);
    if (!table) return;
    const tbody = table.querySelector('tbody');
    if (!tbody) return;

    if (!originalRows[tableId]) {
        originalRows[tableId] = Array.from(tbody.querySelectorAll('tr'));
    }

    if (sortStates[colIndex] === undefined) {
        sortStates[colIndex] = 0;
    }

    // Reset other headers in same table
    const headers = table.querySelectorAll('thead th');
    headers.forEach((th, idx) => {
        if (idx !== colIndex && sortStates[idx] !== undefined) {
            sortStates[idx] = 0;
            updateSortIcon(th, 0);
        }
    });

    const nextState = (sortStates[colIndex] + 1) % 3;
    sortStates[colIndex] = nextState;

    updateSortIcon(headerElement, nextState);

    if (nextState === 0) {
        tbody.innerHTML = '';
        originalRows[tableId].forEach(row => tbody.appendChild(row));
        return;
    }

    const rows = Array.from(tbody.querySelectorAll('tr'));
    rows.sort((a, b) => {
        let valA = getCellValue(a, colIndex, type);
        let valB = getCellValue(b, colIndex, type);

        if (type === 'number') {
            return nextState === 1 ? valA - valB : valB - valA;
        } else {
            return nextState === 1 
                ? valA.localeCompare(valB, undefined, { numeric: true, sensitivity: 'base' })
                : valB.localeCompare(valA, undefined, { numeric: true, sensitivity: 'base' });
        }
    });

    tbody.innerHTML = '';
    rows.forEach(row => tbody.appendChild(row));
};

function getCellValue(row, idx, type) {
    const cell = row.cells[idx];
    if (!cell) return type === 'number' ? 0 : '';
    let text = cell.textContent || cell.innerText;
    text = text.trim();
    if (type === 'number') {
        text = text.replace(/[^0-9.-]/g, '');
        return parseFloat(text) || 0;
    }
    return text.toLowerCase();
}

function updateSortIcon(headerEl, state) {
    let icon = headerEl.querySelector('.sort-icon');
    if (!icon) {
        icon = document.createElement('i');
        icon.className = 'sort-icon fa-solid fa-sort';
        icon.style.marginLeft = '0.35rem';
        icon.style.opacity = '0.4';
        headerEl.appendChild(icon);
    }

    if (state === 0) {
        icon.className = 'sort-icon fa-solid fa-sort';
        icon.style.color = '';
        icon.style.opacity = '0.4';
    } else if (state === 1) {
        icon.className = 'sort-icon fa-solid fa-sort-up';
        icon.style.color = 'var(--primary)';
        icon.style.opacity = '1';
    } else if (state === 2) {
        icon.className = 'sort-icon fa-solid fa-sort-down';
        icon.style.color = 'var(--primary)';
        icon.style.opacity = '1';
    }
}

// ── Auto Reverse Tax Calculator ──
window.autoCalculateReverseTax = function() {
    const grossInput = document.getElementById('gross_total_input');
    const taxSelect = document.getElementById('tax_type');
    const netInput = document.getElementById('amount');

    if (!grossInput || !taxSelect || !netInput) return;

    const gross = parseFloat(grossInput.value);
    if (isNaN(gross) || gross <= 0) return;

    const taxType = taxSelect.value;
    let rate = 0;
    if (taxType === 'GST') rate = 0.05;
    else if (taxType === 'HST13') rate = 0.13;
    else if (taxType === 'HST15') rate = 0.15;

    if (rate > 0) {
        const net = gross / (1 + rate);
        netInput.value = net.toFixed(2);
        if (typeof calculateTotal === 'function') calculateTotal();
    } else {
        netInput.value = gross.toFixed(2);
        if (typeof calculateTotal === 'function') calculateTotal();
    }
};

