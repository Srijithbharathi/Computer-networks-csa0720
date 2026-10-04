(()=> {
  "use strict";
  const $ = id => document.getElementById(id);
  let token = localStorage.getItem("acc_token") || "";
  let catalogue = [];
  let busy = false;
  let pollBusy = false;
  const el = {
    g:$("g"), gpu:$("gpu"), rn:$("rn"), re:$("re"), rp:$("rp"),
    le:$("le"), lp:$("lp"), m:$("m"), d:$("d"), me:$("me"),
    fund:$("fund"), hrs:$("hrs"), jobs:$("jobs")
  };
  function message(text, error=false) {
    el.m.textContent = text || "";
    el.m.style.color = error ? "#ff9b9b" : "";
  }
  async function api(path, options={}) {
    const headers = {...(options.headers || {})};
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    if (token) headers.Authorization = "Bearer " + token;
    let response;
    try { response = await fetch(path, {...options, headers, cache:"no-store"}); }
    catch { throw new Error("Network connection failed. Check your connection and try again."); }
    const data = await response.json().catch(()=>({}));
    if (!response.ok) {
      if (response.status === 401 && token) {
        token = "";
        localStorage.removeItem("acc_token");
        el.d.style.display = "none";
      }
      throw new Error(data.error || "Request failed (" + response.status + ")");
    }
    return data;
  }
  function node(tag, text, className) {
    const n = document.createElement(tag);
    if (text !== undefined && text !== null) n.textContent = String(text);
    if (className) n.className = className;
    return n;
  }
  function money(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n.toFixed(2) : "0.00";
  }
  function renderCatalogue(items) {
    catalogue = Array.isArray(items) ? items : [];
    el.g.replaceChildren();
    el.gpu.replaceChildren();
    if (!catalogue.length) el.g.append(node("p","No GPU products are currently listed.","muted"));
    for (const gpu of catalogue) {
      const card = node("div",undefined,"card gpu");
      card.append(node("b",gpu.name),node("p",gpu.memoryGb + " GB VRAM"),node("strong","$"+money(gpu.priceUsdPerHour)+"/hr"));
      el.g.append(card);
      const option = node("option",gpu.name+" — $"+money(gpu.priceUsdPerHour)+"/hr");
      option.value = gpu.id;
      option.dataset.rate = String(gpu.priceUsdPerHour);
      el.gpu.append(option);
    }
  }
  function renderJobs(jobs) {
    el.jobs.replaceChildren(node("h3","Your GPU jobs"));
    if (!jobs.length) {
      el.jobs.append(node("p","No jobs yet.","muted"));
      return;
    }
    for (const job of jobs) {
      const card = node("div",undefined,"card");
      const row = node("div",undefined,"row");
      row.append(node("b",job.gpuProduct?.name || "GPU job"));
      row.append(node("span",job.status || "UNKNOWN","pill"));
      row.append(node("span",Number(job.requestedHours || 0)+"h","muted"));
      card.append(row);
      if (job.providerJobId && ["PENDING","PROVISIONING","RUNNING","STOPPING"].includes(job.status)) {
        const stop = node("button","Stop GPU");
        stop.type = "button";
        stop.className = "danger";
        stop.addEventListener("click",()=>stopJob(job.id,stop));
        card.append(stop);
      }
      el.jobs.append(card);
    }
  }
  async function dash() {
    if (!token) { el.d.style.display="none"; return; }
    const [user,jobs] = await Promise.all([api("/api/me"),api("/api/jobs")]);
    el.d.style.display = "block";
    el.me.replaceChildren();
    const p = node("p");
    p.append(node("b",user.name),document.createTextNode(" · "+user.email+" · Wallet "));
    p.append(node("strong","$"+money(user.balanceUsd)));
    el.me.append(p);
    renderJobs(Array.isArray(jobs)?jobs:[]);
  }
  async function refreshActiveJobs() {
    if (pollBusy || !token || document.hidden) return;
    pollBusy = true;
    try {
      const jobs = await api("/api/jobs");
      const active = jobs.filter(j=>j.providerJobId && ["PROVISIONING","RUNNING","STOPPING"].includes(j.status));
      await Promise.all(active.map(j=>api("/api/jobs/"+encodeURIComponent(j.id)).catch(()=>null)));
      await dash();
    } catch (err) {
      if (err.message) message(err.message,true);
    } finally { pollBusy=false; }
  }
  async function load() {
    try {
      renderCatalogue(await api("/api/gpus"));
      if (token) {
        try { await dash(); }
        catch (err) { message(err.message,true); }
      }
    } catch (err) { message("Could not load the service: "+err.message,true); }
  }
  async function register() {
    try {
      await api("/api/auth/register",{method:"POST",body:JSON.stringify({
        name:el.rn.value.trim(),email:el.re.value.trim(),password:el.rp.value
      })});
      message("Account created. Sign in to continue.");
    } catch (err) { message(err.message,true); }
  }
  async function login() {
    try {
      const result = await api("/api/auth/login",{method:"POST",body:JSON.stringify({
        email:el.le.value.trim(),password:el.lp.value
      })});
      token = result.token;
      localStorage.setItem("acc_token",token);
      await dash();
      message("Signed in successfully.");
    } catch (err) { message(err.message,true); }
  }
  function logout() {
    token = "";
    localStorage.removeItem("acc_token");
    el.d.style.display="none";
    message("You have signed out.");
  }
  async function pay() {
    const amount = Number(el.fund.value);
    if (!Number.isInteger(amount) || amount < 100 || amount > 1000000) {
      message("Enter a top-up amount between ₹100 and ₹10,00,000.",true); return;
    }
    try {
      const order = await api("/api/payments/order",{method:"POST",body:JSON.stringify({amountInr:amount})});
      if (typeof window.Razorpay !== "function") throw new Error("Payment checkout did not load. Refresh and try again.");
      const checkout = new window.Razorpay({
        key:order.keyId,amount:order.amount,currency:order.currency,
        name:"AI Compute Cloud",description:"Wallet top-up",order_id:order.orderId,
        handler:async result=>{
          try {
            await api("/api/payments/verify",{method:"POST",body:JSON.stringify(result)});
            await dash();
            message("Payment verified and wallet updated.");
          } catch (err) { message("Payment confirmation needs attention: "+err.message,true); }
        },
        modal:{ondismiss:()=>message("Payment window closed. If you completed payment, check your wallet before trying again.")}
      });
      checkout.on("payment.failed",detail=>{
        message(detail?.error?.description || "Payment did not complete. Your wallet was not credited.",true);
      });
      checkout.open();
    } catch (err) { message(err.message,true); }
  }
  async function launch() {
    if (busy) return;
    const gpuId = el.gpu.value;
    const hours = Number(el.hrs.value);
    const selected = catalogue.find(g=>g.id===gpuId);
    if (!selected) { message("Select a GPU first.",true); return; }
    if (!Number.isFinite(hours) || hours < 0.25 || hours > 12) {
      message("Choose a duration from 0.25 to 12 hours.",true); return;
    }
    const estimate = Number(selected.priceUsdPerHour)*hours;
    if (!window.confirm("Request "+selected.name+" for "+hours+" hour(s)? Estimated reservation: $"+money(estimate)+". Provider availability is not guaranteed.")) return;
    busy=true;
    const button=$("jobBtn"); if(button) button.disabled=true;
    try {
      const result=await api("/api/jobs",{method:"POST",body:JSON.stringify({gpuProductId:gpuId,requestedHours:hours})});
      message("GPU request submitted. Current status: "+(result.provider?.status || result.job?.status || "PROVISIONING"));
      await dash();
    } catch (err) { message(err.message,true); }
    finally { busy=false; if(button) button.disabled=false; }
  }
  async function stopJob(id,button) {
    if (button?.disabled) return;
    if (!window.confirm("Stop this GPU job? Any refund is based on the server's usage calculation.")) return;
    if(button) button.disabled=true;
    try {
      const result=await api("/api/jobs/"+encodeURIComponent(id)+"/stop",{method:"POST"});
      message("Stop request completed. Wallet refund: $"+money(result.refundUsd || 0));
      await dash();
    } catch (err) { message(err.message,true); }
    finally { if(button) button.disabled=false; }
  }
  const bind=(id,fn)=>{const button=$(id);if(button)button.addEventListener("click",fn);};
  bind("regBtn",register);
  bind("loginBtn",login);
  bind("logoutBtn",logout);
  bind("payBtn",pay);
  bind("jobBtn",launch);
  load();
  window.setInterval(refreshActiveJobs,15000);
})();