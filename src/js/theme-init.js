// Linetime — applies the saved theme before the page is drawn.
// SPDX-License-Identifier: GPL-3.0-or-later
try{var t=localStorage.getItem("linetime-theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t;}catch(e){}
