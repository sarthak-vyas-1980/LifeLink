"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Bell, Droplets, LayoutDashboard, LogOut, MapPinned, ClipboardList, HeartPulse } from "lucide-react";
import { getCurrentSession, signOut } from "../../lib/auth";
import { connectRealtime, subscribeToWorkflowEvents } from "../../lib/socket-client";
import { requestApi } from "../../lib/api-client";

const links=[{href:"/dashboard",label:"Overview",icon:LayoutDashboard},{href:"/requests",label:"Blood requests",icon:ClipboardList},{href:"/organ-centre",label:"Organ coordination",icon:HeartPulse,organ:true},{href:"/map",label:"Institution map",icon:MapPinned},{href:"/notifications",label:"Notifications",icon:Bell}];
export default function DashboardShell({children}:{children:React.ReactNode}){
  const router=useRouter();const pathname=usePathname();const [session,setSession]=useState<ReturnType<typeof getCurrentSession>>(null);const [unread,setUnread]=useState(0);
  useEffect(()=>{const current=getCurrentSession();if(!current){router.replace("/login");return;}setSession(current);connectRealtime(current.token);const refresh=()=>void requestApi<{notifications:Array<{status:string}>}>("/api/notifications?limit=100").then((data)=>setUnread(data.notifications.filter((n)=>n.status==="UNREAD").length)).catch(()=>{});refresh();return subscribeToWorkflowEvents(refresh);},[router]);
  const logout=async()=>{await signOut();router.replace("/login");};
  if(!session)return <div className="auth-loading">Loading your LifeLink workspace…</div>;
  return <div className="app-shell"><aside className="sidebar"><Link href="/dashboard" className="brand"><span className="brand-icon"><Droplets size={20}/></span><span>LifeLink<small>Care coordination</small></span></Link><div className="side-label">WORKSPACE</div><nav>{links.filter(({organ})=>!organ||session.user.role==="ORGAN_CENTRE_USER"||session.user.role==="ADMINISTRATOR").map(({href,label,icon:Icon})=><Link key={href} href={href} className={`nav-link ${pathname===href||pathname.startsWith(`${href}/`)?"selected":""}`}><Icon size={18}/>{label}{label==="Notifications"&&unread>0&&<b>{unread}</b>}</Link>)}</nav><div className="sidebar-bottom"><span className="avatar">{session.user.name.slice(0,1).toUpperCase()}</span><span className="profile-text"><strong>{session.user.name}</strong><small>{session.user.role.replaceAll("_"," ")}</small></span><button className="icon-button" title="Sign out" onClick={()=>void logout()}><LogOut size={17}/></button></div></aside><main className="main-content">{children}</main></div>;
}
